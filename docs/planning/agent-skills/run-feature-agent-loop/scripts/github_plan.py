"""Freeze a GitHub issue plan for an agent run. Reads GitHub; never launches or writes remotely."""
import argparse
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone


def digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def canonical_text(value):
    return value.replace('\r\n', '\n').replace('\r', '\n')


def gh(*args):
    result = subprocess.run(['gh', *args], capture_output=True, encoding='utf-8')
    if result.returncode:
        raise ValueError(result.stderr.strip())
    return json.loads(result.stdout)


def issue(repo, number):
    return gh('issue', 'view', str(number), '--repo', repo,
              '--json', 'id,number,url,title,body,state,updatedAt')


def parse_plan(body):
    plans = []
    for block in re.findall(r'```json\s*\n(.*?)```', body, re.S):
        try:
            parsed = json.loads(block)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict) and 'agent_plan' in parsed:
            plans.append(parsed['agent_plan'])
    if len(plans) != 1:
        raise ValueError('Expected exactly one JSON agent_plan in the parent issue')
    return plans[0]


def validate_plan(plan, repo, allow_closed=False):
    if plan.get('version') != 2:
        raise ValueError('Expected agent_plan version 2')
    if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', plan.get('feature_slug', '')):
        raise ValueError('Invalid feature_slug')
    if plan.get('readiness') not in ('ready', 'active') and not allow_closed:
        raise ValueError('Deferred or delivered plans cannot launch')
    for key in ('milestone', 'default_branch', 'integration_branch', 'source_base'):
        if not isinstance(plan.get(key), str) or not plan[key]:
            raise ValueError(f'Missing {key}')
    if not re.fullmatch(r'[a-f0-9]{40}', plan['source_base']):
        raise ValueError('source_base must be a full SHA; refresh the actual launch base separately')
    tasks = plan.get('tasks', [])
    if not tasks:
        raise ValueError('No executable tasks')
    ids, urls, branches = set(), set(), set()
    for task in tasks:
        task_id = task.get('id')
        if not isinstance(task_id, str) or not re.fullmatch(r'[0-9]{2}', task_id) or task_id in ids:
            raise ValueError('Task IDs must be unique two-digit strings')
        ids.add(task_id)
        url = task.get('issue_url', '')
        if not re.fullmatch(r'https://github\.com/' + re.escape(repo) + r'/issues/[1-9][0-9]*', url) or url in urls:
            raise ValueError(f'Invalid or duplicate task issue URL: {url}')
        urls.add(url)
        branch = task.get('branch', '')
        if not branch.startswith('codex/') or branch in branches:
            raise ValueError('Missing or duplicate worker branch')
        branches.add(branch)
        if task.get('delivery') not in ('default-branch-pr', 'integration-only'):
            raise ValueError('Invalid task delivery classification')
        if task.get('base_policy') not in ('latest-default', 'integration-tip'):
            raise ValueError('Invalid base policy')
        if not isinstance(task.get('wave'), int) or task['wave'] < 1:
            raise ValueError('Invalid wave')
        for key in ('depends_on', 'acceptance', 'checks'):
            if not isinstance(task.get(key), list) or any(not isinstance(x, str) for x in task[key]):
                raise ValueError(f'Invalid {key}')
        if not task['acceptance'] or not task['checks']:
            raise ValueError('Tasks require acceptance IDs and checks')
    task_map = {t['id']: t for t in tasks}
    visiting, visited = set(), set()
    def visit(task_id):
        if task_id in visiting:
            raise ValueError('Dependency cycle')
        if task_id in visited:
            return
        visiting.add(task_id)
        for dep in task_map[task_id]['depends_on']:
            if dep not in task_map:
                raise ValueError(f'Unknown prerequisite {dep}')
            if task_map[dep]['wave'] >= task_map[task_id]['wave']:
                raise ValueError('Dependency must be in an earlier wave')
            visit(dep)
        visiting.remove(task_id)
        visited.add(task_id)
    for task_id in task_map:
        visit(task_id)
    return plan


def snapshot(repo, number, output, allow_closed=False):
    parent = issue(repo, number)
    if parent['state'] != 'OPEN' and not allow_closed:
        raise ValueError('Parent issue is closed')
    plan = validate_plan(parse_plan(parent['body']), repo, allow_closed)
    documents = [parent]
    files = {'README.md': canonical_text(parent['body']) + '\n'}
    for task in plan['tasks']:
        child = issue(repo, task['issue_url'].rsplit('/', 1)[1])
        if child['state'] != 'OPEN' and not allow_closed:
            raise ValueError(f"Task {task['id']} is closed; reconcile the run before launch")
        task['prompt'] = f"{task['id']}-issue-{child['number']}.md"
        files[task['prompt']] = canonical_text(child['body']) + '\n'
        documents.append(child)
    # A concurrent editor must not produce a mixed revision snapshot.
    for doc in documents:
        current = issue(repo, doc['number'])
        if any(current[k] != doc[k] for k in ('body', 'title', 'updatedAt', 'state')):
            raise ValueError(f"Issue #{doc['number']} changed during snapshot; retry from current truth")
    manifest = {
        'version': 2, 'repository': repo, 'parent_issue': parent['url'],
        'project_url': plan.get('project_url'),
        'captured_at': datetime.now(timezone.utc).isoformat(),
        'agent_plan': plan,
        'issues': [{k: d[k] for k in ('id', 'number', 'url', 'title', 'state', 'updatedAt')}
                   | {'body_sha256': digest(d['body'])} for d in documents],
        'files': {name: digest(body) for name, body in files.items()},
    }
    output = pathlib.Path(output).resolve()
    if output.exists():
        raise ValueError('Snapshot output already exists; snapshots are immutable')
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = pathlib.Path(tempfile.mkdtemp(prefix='.snapshot-', dir=output.parent))
    try:
        for name, body in files.items():
            (temporary / name).write_text(body, encoding='utf-8', newline='\n')
        (temporary / 'snapshot.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8', newline='\n')
        temporary.rename(output)
    finally:
        if temporary.exists() and temporary.resolve().parent == output.parent:
            shutil.rmtree(temporary)
    return {'path': str(output), 'manifest_sha256': digest((output / 'snapshot.json').read_text(encoding='utf-8')),
            'parent_issue': parent['url'], 'tasks': len(plan['tasks'])}


def verify(output, check_remote=False):
    output = pathlib.Path(output).resolve()
    manifest = json.loads((output / 'snapshot.json').read_text(encoding='utf-8'))
    validate_plan(manifest['agent_plan'], manifest['repository'], allow_closed=True)
    for name, expected in manifest['files'].items():
        path = (output / name).resolve()
        if path.parent != output or (output / name).is_symlink():
            raise ValueError('Snapshot file escapes its root')
        if digest(path.read_text(encoding='utf-8')) != expected:
            raise ValueError(f'Snapshot was modified: {name}')
    if check_remote:
        for doc in manifest['issues']:
            current = issue(manifest['repository'], doc['number'])
            if digest(current['body']) != doc['body_sha256'] or current['title'] != doc['title']:
                raise ValueError(f"Plan drift in issue #{doc['number']}; preserve this run and replan explicitly")
    return {'verified': True, 'tasks': len(manifest['agent_plan']['tasks']),
            'remote_checked': check_remote}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    snap = sub.add_parser('snapshot')
    snap.add_argument('--repo', required=True)
    snap.add_argument('--issue', type=int, required=True)
    snap.add_argument('--output', required=True)
    snap.add_argument('--allow-closed', action='store_true', help='Audit only; does not authorize launch')
    check = sub.add_parser('verify')
    check.add_argument('--output', required=True)
    check.add_argument('--remote', action='store_true')
    args = parser.parse_args()
    try:
        result = snapshot(args.repo, args.issue, args.output, args.allow_closed) if args.command == 'snapshot' else verify(args.output, args.remote)
        print(json.dumps(result))
    except (ValueError, KeyError, OSError, json.JSONDecodeError) as exc:
        parser.exit(1, f'{exc}\n')


if __name__ == '__main__':
    main()
