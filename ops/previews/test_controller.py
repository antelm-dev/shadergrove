import importlib.util
import io
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('preview_controller', Path(__file__).with_name('controller.py'))
controller = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controller)
HEAD, BASE, COMMIT = 'a' * 40, 'b' * 40, 'c' * 40
PR = {'state': 'open', 'draft': False, 'labels': [{'name': 'preview'}],
      'head': {'sha': HEAD, 'repo': {'full_name': controller.REPOSITORY}},
      'base': {'ref': 'develop', 'sha': BASE, 'repo': {'full_name': controller.REPOSITORY}},
      'merge_commit_sha': COMMIT}
RUN = {'event': 'pull_request', 'path': '.github/workflows/ci.yml', 'status': 'completed',
       'conclusion': 'success', 'head_sha': HEAD, 'head_repository': {'full_name': controller.REPOSITORY}}


class PreviewTests(unittest.TestCase):
    def test_restricted_command_does_not_accept_shell_or_path_input(self):
        valid = f'deploy 52 123 {HEAD} {BASE} {COMMIT} sha256:' + 'd' * 64
        self.assertEqual(controller.parse_command(valid)[0], 'deploy')
        self.assertEqual(controller.parse_command('delete 52'), ('delete', '52'))
        self.assertEqual(controller.parse_command('prune'), ('prune',))
        for value in ['sh', 'delete ../staging', 'delete 0', 'delete 52; id', valid + ' extra', 'prune\nid']:
            with self.assertRaises(ValueError):
                controller.parse_command(value)

    def test_failed_ci_or_stale_source_never_passes_the_server_gate(self):
        controller.validate_request(PR, RUN, HEAD, BASE, COMMIT)
        for key, value in [('conclusion', 'failure'), ('event', 'push'), ('head_sha', BASE)]:
            with self.assertRaises(ValueError):
                controller.validate_request(PR, {**RUN, key: value}, HEAD, BASE, COMMIT)
        for values in [(BASE, BASE, COMMIT), (HEAD, HEAD, COMMIT), (HEAD, BASE, HEAD)]:
            with self.assertRaises(ValueError):
                controller.validate_request(PR, RUN, *values)

    def test_forks_drafts_and_unlabelled_prs_are_ineligible(self):
        for change in [{'draft': True}, {'labels': []}, {'state': 'closed'},
                       {'head': {**PR['head'], 'repo': None}}]:
            self.assertFalse(controller.eligible({**PR, **change}))

    def test_cleanup_cannot_remove_an_active_pr(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = controller.Manager('token', root=Path(directory))
            manager.directory('52').mkdir()
            manager.api = lambda path: PR
            manager.run = lambda *args, **kwargs: self.fail('No Docker operation expected')
            with self.assertRaises(ValueError):
                manager.remove('52')
            self.assertTrue(manager.directory('52').exists())

    def test_cleanup_targets_only_this_prs_project_and_volumes(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = controller.Manager('token', root=Path(directory), template=Path('compose.yml'))
            target = manager.directory('52')
            target.mkdir()
            (target / '.env').write_text('')
            other = manager.directory('53')
            other.mkdir()
            manager.api = lambda path: {**PR, 'state': 'closed'}
            manager.connected = lambda number: False
            calls = []
            manager.run = lambda *args, **kwargs: calls.append(args) or ''
            manager.remove('52')
            self.assertFalse(target.exists())
            self.assertTrue(other.exists())
            self.assertIn('shadergrove-pr-52', calls[0])
            self.assertIn('--volumes', calls[0])

    def test_image_pull_never_happens_when_two_previews_are_allocated(self):
        with tempfile.TemporaryDirectory() as directory:
            manager = controller.Manager('token', root=Path(directory))
            manager.directory('53').mkdir()
            manager.directory('54').mkdir()
            def api(path):
                if path.startswith('pulls/'): return PR
                if path.startswith('actions/runs/'): return RUN
                if path.startswith('actions/workflows/'): return {'workflow_runs': [{'id': 123}]}
                if path.startswith('git/commits/'): return {'parents': [{'sha': BASE}, {'sha': HEAD}]}
                self.fail(path)
            manager.api = api
            manager.run = lambda *args, **kwargs: self.fail('Must not pull or modify containers')
            with self.assertRaisesRegex(ValueError, 'Two previews'):
                manager.deploy('52', '123', HEAD, BASE, COMMIT, 'sha256:' + 'd' * 64)

    def test_artifact_reader_refuses_extra_files_paths_and_large_records(self):
        script = Path(__file__).resolve().parents[2] / '.github/scripts/read-preview-source.py'
        for name, content in [('preview-source.json', '{}'), ('../preview-source.json', '{}'),
                              ('preview-source.json', 'x' * 4097)]:
            archive = io.BytesIO()
            with zipfile.ZipFile(archive, 'w') as data:
                data.writestr(name, content)
            result = subprocess.run([sys.executable, str(script)], input=archive.getvalue(), capture_output=True)
            self.assertEqual(result.returncode == 0, name == 'preview-source.json' and len(content) < 4096)


if __name__ == '__main__':
    unittest.main()
