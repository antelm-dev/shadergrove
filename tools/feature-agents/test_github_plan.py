"""Behavioral checks for immutable GitHub issue launch packets; no live GitHub writes."""
import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

PATH = pathlib.Path(__file__).with_name('github_plan.py')
spec = importlib.util.spec_from_file_location('github_plan', PATH)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def plan():
    return dict(version=2, feature_slug='example', milestone='example-phase1', readiness='ready',
                source_base='a' * 40, default_branch='master', integration_branch='codex/integrate-example',
                project_url='https://github.com/users/example/projects/1', tasks=[dict(
                    id='01', issue_url='https://github.com/example/repo/issues/2',
                    branch='codex/example-01', wave=1, depends_on=[], acceptance=['AC-ONE'],
                    checks=['npm test'], delivery='default-branch-pr', base_policy='latest-default')])


class SnapshotTests(unittest.TestCase):
    def documents(self):
        return {
            1: dict(id='parent', number=1, url='https://github.com/example/repo/issues/1', title='Feature',
                    state='OPEN', updatedAt='2026-10-06T00:00:00Z', body='Goal\n```json\n' +
                    json.dumps(dict(agent_plan=plan())) + '\n```'),
            2: dict(id='task', number=2, url='https://github.com/example/repo/issues/2', title='Task',
                    state='OPEN', updatedAt='2026-10-06T00:00:00Z', body='Implement this bounded outcome'),
        }

    def test_snapshot_roundtrip_and_tamper(self):
        docs = self.documents()
        with tempfile.TemporaryDirectory() as root, patch.object(
                module, 'issue', side_effect=lambda repo, n: docs[int(n)].copy()):
            out = pathlib.Path(root) / 'snapshot'
            module.snapshot('example/repo', 1, out)
            self.assertTrue(module.verify(out, True)['verified'])
            with self.assertRaises(ValueError):
                module.snapshot('example/repo', 1, out)
            (out / '01-issue-2.md').write_text('tampered')
            with self.assertRaises(ValueError):
                module.verify(out)

    def test_github_crlf_bodies_have_portable_file_hashes(self):
        docs = self.documents()
        for doc in docs.values():
            doc['body'] = doc['body'].replace('\n', '\r\n')
        with tempfile.TemporaryDirectory() as root, patch.object(
                module, 'issue', side_effect=lambda repo, n: docs[int(n)].copy()):
            out = pathlib.Path(root) / 'snapshot'
            module.snapshot('example/repo', 1, out)
            self.assertTrue(module.verify(out, True)['verified'])
            self.assertNotIn(b'\r\n', (out / 'README.md').read_bytes())

    def test_concurrent_edit_leaves_no_partial_snapshot(self):
        docs = self.documents()
        calls = {1: 0, 2: 0}

        def fetch(repo, n):
            n = int(n)
            calls[n] += 1
            doc = docs[n].copy()
            if n == 2 and calls[n] > 1:
                doc['body'] = 'changed during read'
            return doc

        with tempfile.TemporaryDirectory() as root, patch.object(module, 'issue', side_effect=fetch):
            out = pathlib.Path(root) / 'snapshot'
            with self.assertRaises(ValueError):
                module.snapshot('example/repo', 1, out)
            self.assertFalse(out.exists())

    def test_scope_drift_detected_but_state_only_change_allowed(self):
        docs = self.documents()
        with tempfile.TemporaryDirectory() as root, patch.object(
                module, 'issue', side_effect=lambda repo, n: docs[int(n)].copy()):
            out = pathlib.Path(root) / 'snapshot'
            module.snapshot('example/repo', 1, out)
            docs[2]['state'] = 'CLOSED'
            docs[2]['updatedAt'] = 'later'
            self.assertTrue(module.verify(out, True)['verified'])
            docs[2]['body'] = 'new scope'
            with self.assertRaises(ValueError):
                module.verify(out, True)

    def test_closed_and_deferred_plans_do_not_launch(self):
        docs = self.documents()
        docs[2]['state'] = 'CLOSED'
        with tempfile.TemporaryDirectory() as root, patch.object(
                module, 'issue', side_effect=lambda repo, n: docs[int(n)].copy()):
            with self.assertRaises(ValueError):
                module.snapshot('example/repo', 1, pathlib.Path(root) / 'snapshot')
        value = plan()
        value['readiness'] = 'deferred'
        with self.assertRaises(ValueError):
            module.validate_plan(value, 'example/repo')

    def test_wrong_repo_duplicate_and_dependency_cycle_rejected(self):
        value = plan()
        value['tasks'][0]['issue_url'] = 'https://github.com/other/repo/issues/2'
        with self.assertRaises(ValueError):
            module.validate_plan(value, 'example/repo')
        value = plan()
        value['tasks'].append(value['tasks'][0].copy())
        with self.assertRaises(ValueError):
            module.validate_plan(value, 'example/repo')
        value = plan()
        value['tasks'][0]['depends_on'] = ['01']
        with self.assertRaises(ValueError):
            module.validate_plan(value, 'example/repo')

    def test_manifest_path_escape_rejected(self):
        docs = self.documents()
        with tempfile.TemporaryDirectory() as root, patch.object(
                module, 'issue', side_effect=lambda repo, n: docs[int(n)].copy()):
            out = pathlib.Path(root) / 'snapshot'
            module.snapshot('example/repo', 1, out)
            manifest = json.loads((out / 'snapshot.json').read_text())
            manifest['files']['../escape.md'] = 'any'
            (out / 'snapshot.json').write_text(json.dumps(manifest))
            with self.assertRaises(ValueError):
                module.verify(out)


if __name__ == '__main__':
    unittest.main()
