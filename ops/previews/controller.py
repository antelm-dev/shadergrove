#!/usr/bin/python3
"""Root-owned forced SSH command. PRs cannot supply Compose files or shell code."""
import http.cookiejar
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

REPOSITORY = 'antelm-dev/shadergrove'
ROOT = Path('/var/lib/shadergrove-previews')
TEMPLATE = Path('/etc/shadergrove-previews/compose.yml')
SUFFIX = '45-155-170-120.sslip.io'
IMAGE = 'ghcr.io/antelm-dev/shadergrove-preview'
LIMIT = 2
SHA = r'[a-f0-9]{40}'
DIGEST = r'sha256:[a-f0-9]{64}'
NUMBER = r'[1-9][0-9]{0,11}'


def parse_command(command):
    deploy = re.fullmatch(rf'deploy ({NUMBER}) ({NUMBER}) ({SHA}) ({SHA}) ({SHA}) ({DIGEST})', command)
    if deploy:
        return ('deploy', *deploy.groups())
    delete = re.fullmatch(rf'delete ({NUMBER})', command)
    if delete:
        return ('delete', delete.group(1))
    if command == 'prune':
        return ('prune',)
    raise ValueError('Expected a restricted deploy, delete or prune request')


def eligible(pr):
    return (pr['state'] == 'open' and not pr['draft'] and
            pr['base']['ref'] == 'develop' and
            pr['base']['repo']['full_name'] == REPOSITORY and
            (pr['head'].get('repo') or {}).get('full_name') == REPOSITORY and
            any(label['name'] == 'preview' for label in pr['labels']))


def validate_request(pr, run, head, base, commit):
    if not eligible(pr):
        raise ValueError('PR no longer qualifies for a preview')
    if (pr['head']['sha'] != head or pr['base']['sha'] != base or
            pr['merge_commit_sha'] != commit or
            run['event'] != 'pull_request' or run['path'] != '.github/workflows/ci.yml' or
            run['status'] != 'completed' or run['conclusion'] != 'success' or
            run['head_sha'] != head or run['head_repository']['full_name'] != REPOSITORY):
        raise ValueError('PR changed or its CI did not pass; refusing stale deployment')


class Manager:
    def __init__(self, token, root=ROOT, template=TEMPLATE, username='github-actions'):
        self.token = token
        self.username = username
        self.root = root
        self.template = template

    def api(self, path):
        request = urllib.request.Request(f'https://api.github.com/repos/{REPOSITORY}/{path}', headers={
            'Authorization': f'Bearer {self.token}',
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'shadergrove-preview-controller',
        })
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.load(response)

    @staticmethod
    def run(*args, capture=False, **kwargs):
        result = subprocess.run(args, check=True, text=True,
                                stdout=kwargs.pop('stdout', subprocess.PIPE if capture else None), **kwargs)
        return result.stdout.strip() if capture else ''

    def directory(self, number):
        if not re.fullmatch(NUMBER, str(number)):
            raise ValueError('Invalid preview number')
        directory = self.root / f'pr-{number}'
        if directory.is_symlink():
            raise ValueError('Refusing a symlink preview directory')
        return directory

    def directories(self):
        return [path for path in self.root.iterdir()
                if re.fullmatch(r'pr-[1-9][0-9]*', path.name) and path.is_dir() and not path.is_symlink()]

    def compose(self, number, *args, **kwargs):
        return self.run('docker', 'compose', '--project-name', f'shadergrove-pr-{number}',
                        '--env-file', str(self.directory(number) / '.env'),
                        '--file', str(self.template), *args, **kwargs)

    def remove(self, number):
        directory = self.directory(number)
        if not directory.exists():
            return
        if eligible(self.api(f'pulls/{number}')):
            raise ValueError('PR is still active; refusing to delete its preview')
        self.run('docker', 'network', 'disconnect', '-f', f'shadergrove-pr-{number}_edge', 'dokploy-traefik',
                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) if self.connected(number) else None
        self.compose(number, 'down', '--volumes', '--remove-orphans')
        # Only controller-owned regular files are removed. Never recurse over
        # user-provided paths and never remove another application's volumes.
        for path in directory.iterdir():
            if not path.is_file() or path.is_symlink():
                raise ValueError('Unexpected preview state file')
            path.unlink()
        directory.rmdir()
        print(f'Preview PR #{number} removed', flush=True)

    def connected(self, number):
        network = f'shadergrove-pr-{number}_edge'
        networks = json.loads(self.run('docker', 'inspect', 'dokploy-traefik',
                                     '--format', '{{json .NetworkSettings.Networks}}', capture=True))
        return network in networks

    def prune(self):
        for directory in self.directories():
            number = directory.name[3:]
            if not eligible(self.api(f'pulls/{number}')):
                self.remove(number)

    def deploy(self, number, run_id, head, base, commit, digest):
        pr = self.api(f'pulls/{number}')
        run = self.api(f'actions/runs/{run_id}')
        validate_request(pr, run, head, base, commit)
        latest = self.api(f'actions/workflows/ci.yml/runs?event=pull_request&head_sha={head}&per_page=1')
        if not latest['workflow_runs'] or latest['workflow_runs'][0]['id'] != int(run_id):
            raise ValueError('A newer CI run superseded this deployment')
        parents = self.api(f'git/commits/{commit}')['parents']
        if [parent['sha'] for parent in parents] != [base, head]:
            raise ValueError('Expected the tested PR merge commit')
        directory = self.directory(number)
        if not directory.exists() and len(self.directories()) >= LIMIT:
            raise ValueError('Two previews are already allocated; remove a preview label to free a slot')
        image = f'{IMAGE}@{digest}'
        # Login exists only for the pull, using this job's read-only package
        # token. It is never passed to the app or kept as a registry credential.
        with tempfile.TemporaryDirectory(prefix='shadergrove-registry-') as config:
            self.run('docker', '--config', config, 'login', 'ghcr.io', '--username', self.username,
                     '--password-stdin', input=self.token, stdout=subprocess.DEVNULL)
            self.run('docker', '--config', config, 'pull', image)
        revision = self.run('docker', 'inspect', image, '--format',
                            '{{index .Config.Labels "org.opencontainers.image.revision"}}', capture=True)
        if revision != commit:
            raise ValueError('Image revision does not match the tested merge commit')
        # Recheck after the pull; label removal, PR closure, or a new push must
        # prevent a queued request from bringing the old environment back.
        validate_request(self.api(f'pulls/{number}'), self.api(f'actions/runs/{run_id}'), head, base, commit)
        self.start(number, image)
        self.seed(number)
        (directory / 'state.json').write_text(json.dumps({'pr': int(number), 'run': int(run_id), 'commit': commit, 'digest': digest}))
        print(f'Preview ready: https://pr-{number}.{SUFFIX}/ at {commit}', flush=True)

    def start(self, number, image):
        directory = self.directory(number)
        directory.mkdir(mode=0o700, exist_ok=True)
        env = directory / '.env'
        if env.exists():
            values = dict(line.split('=', 1) for line in env.read_text().splitlines())
        else:
            values = {'POSTGRES_PASSWORD': secrets.token_hex(32), 'BETTER_AUTH_SECRET': secrets.token_hex(32)}
            credentials = {'email': 'preview@example.test', 'password': secrets.token_hex(16)}
            (directory / 'credentials.json').write_text(json.dumps(credentials))
        values.update(PREVIEW_IMAGE=image, PREVIEW_PROJECT=f'shadergrove-pr-{number}', PREVIEW_HOST=f'pr-{number}.{SUFFIX}',
                      PREVIEW_ROUTER=f'shadergrove-pr-{number}-{secrets.token_hex(4)}')
        env.write_text(''.join(f'{key}={value}\n' for key, value in values.items()))
        self.compose(number, 'up', '--detach', '--wait', '--wait-timeout', '180')
        if not self.connected(number):
            self.run('docker', 'network', 'connect', f'shadergrove-pr-{number}_edge', 'dokploy-traefik')
        url = f'https://pr-{number}.{SUFFIX}/api/health'
        deadline = time.monotonic() + 180
        retry_route_at = time.monotonic() + 60
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(url, timeout=10) as response:
                    if json.load(response).get('status') == 'ok':
                        return
            except (urllib.error.URLError, TimeoutError):
                pass
            if time.monotonic() >= retry_route_at:
                # Refresh only this preview's router if the initial ACME request
                # failed transiently. Existing staging routes stay untouched.
                values['PREVIEW_ROUTER'] = f'shadergrove-pr-{number}-{secrets.token_hex(4)}'
                env.write_text(''.join(f'{key}={value}\n' for key, value in values.items()))
                self.compose(number, 'up', '--detach', '--no-deps', 'studio')
                retry_route_at = time.monotonic() + 60
            time.sleep(3)
        raise RuntimeError('Preview HTTPS/database readiness did not succeed')

    def seed(self, number):
        directory = self.directory(number)
        credentials = json.loads((directory / 'credentials.json').read_text())
        origin = f'https://pr-{number}.{SUFFIX}'
        browser = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

        def request(path, payload=None):
            data = json.dumps(payload).encode() if payload is not None else None
            call = urllib.request.Request(origin + path, data=data,
                                          headers={'Origin': origin, 'Content-Type': 'application/json'})
            with browser.open(call, timeout=20) as response:
                return json.load(response)

        # Signup runs only when the account is absent, avoiding repeat email
        # sends and leaving users' existing preview data intact on redeploy.
        count = self.compose(number, 'exec', '-T', 'postgres', 'psql', '-U', 'preview', '-d', 'preview', '-Atc',
                             "SELECT count(*) FROM users WHERE email = 'preview@example.test'", capture=True)
        if count == '0':
            request('/api/auth/sign-up/email', {'name': 'Preview', **credentials})
            self.compose(number, 'exec', '-T', 'postgres', 'psql', '-U', 'preview', '-d', 'preview', '-c',
                         "UPDATE users SET email_verified = true WHERE email = 'preview@example.test'")
        request('/api/auth/sign-in/email', credentials)
        existing = {shader['id'] for shader in request('/api/shaders')['shaders']}
        fixtures = json.loads(Path('/etc/shadergrove-previews/fixtures.json').read_text())
        for fixture in fixtures:
            if fixture['id'] not in existing:
                request('/api/shaders', fixture['payload'])


def main():
    import fcntl
    os.umask(0o077)
    command = parse_command(os.environ.get('SSH_ORIGINAL_COMMAND', ''))
    payload = sys.stdin.buffer.read(8193)
    if len(payload) > 8192:
        raise ValueError('Oversized preview request')
    request = json.loads(payload)
    token = request['token']
    username = request['username']
    if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{20,4096}', token):
        raise ValueError('Expected an ephemeral GitHub token')
    if not isinstance(username, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_\[\]-]{0,99}', username):
        raise ValueError('Expected a GitHub actor')
    ROOT.mkdir(mode=0o700, exist_ok=True)
    with (ROOT / '.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        manager = Manager(token, username=username)
        if command[0] == 'deploy':
            manager.deploy(*command[1:])
        elif command[0] == 'delete':
            manager.remove(command[1])
        else:
            manager.prune()


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError, urllib.error.URLError, subprocess.CalledProcessError) as error:
        print(f'Preview request failed: {error}', file=sys.stderr)
        sys.exit(1)
