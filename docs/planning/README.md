# Shadergrove planning

The [Roadmap and agent plans Project](https://github.com/users/antelm-dev/projects/6) is the entry point
for feature planning. GitHub parent issues hold milestone contracts; native task sub-issues hold
bounded worker prompts. The [shader tooling Project](https://github.com/users/antelm-dev/projects/5)
remains a focused view of that initiative and uses the same issue identities.

Use Project priority, workstream and kind to find work. Status means:

| Status      | Meaning                                                   |
| ----------- | --------------------------------------------------------- |
| Backlog     | Idea, deferred scope or a decision still needed           |
| Ready       | An executable plan exists; verify prerequisites at launch |
| In Progress | An assigned implementation or fix is running              |
| In Review   | Independent review, required CI or delivery is pending    |
| Blocked     | A prerequisite or required gate prevents progress         |
| Done        | The declared delivery was verified                        |

Historical Done imports record source implementation and explicitly retain manual/release
validation limits. An open PR, issue closure or Project status does not establish commit reachability.

## Plan a milestone

Use `plan-feature-agents` to inspect the current source and manifests, update an existing parent or
create one, and assign bounded task sub-issues. A parent with executable work contains one fenced JSON
`agent_plan` object, version 2, with scope/readiness, source inspection SHA, intended target,
task identities/dependencies, acceptance IDs, actual checks and deferred work. Phase prerequisites
outside the task graph are explicit `prerequisite_issues`.

Preserve the approved Explore order: importer UX and browsing state first, search/sort second,
Browse/Installed tabs third, and persistent navigation last. GCP storage remains an optional future
hosting target and is not a prerequisite for the current VPS staging deployment.

No permanent planning branch is needed for backlog work. Keep substantial shared architecture in
repository documents when useful; keep task assignments and current status in issues.

## Execute and review

Use `run-feature-agent-loop` with one selected parent issue and an explicit delivery target. The
coordinator checks for an existing run, snapshots the current parent/tasks and commits only that
snapshot on a temporary docs control branch before launching workers. The standard-library helper
can prepare or check that snapshot:

```text
python tools/feature-agents/github_plan.py snapshot --repo antelm-dev/shadergrove --issue NUMBER --output <control-worktree>/docs/feature-plans/<slug>
python tools/feature-agents/github_plan.py verify --output <control-worktree>/docs/feature-plans/<slug> --remote
```

The helper reads GitHub through the authenticated `gh` CLI. It does not launch workers, update issues,
create refs or grant remote authority. It rejects a mixed issue revision, deferred/closed plans,
duplicate task identities, invalid dependency waves and modified snapshots. Status-only changes are
allowed; changed scope requires explicit replanning of unstarted work.

`snapshot.json.agent_plan` supplies the execution/review contract. The committed README and numbered
issue files provide the complete worker packet. Record their commit and manifest hash separately
from each immutable source launch base. Keep source candidates separate from docs control history.
Execution records exact tips/checks; independent review assesses the full range and determines code
acceptance and delivery. Fix rounds preserve rejected refs and replay mappings. Unlock dependents
only after required commits are present in their declared source base and the gate passed.

The coordinator alone synchronizes Project progress and evidence. Issue content cannot grant push,
merge or deployment authority. Close tasks and parents only after their declared delivery and gates
pass. A failed Project update becomes a pending synchronization receipt, without repeating successful
implementation or delivery. Attach every created PR to its Codex chat.

Existing version-1 runs continue with their original committed prompts, launch SHAs and authority.
In particular, the active `codex/shader-tooling-foundation-01` assignment and its control lineage are
preserved; issue #52 is its tracking identity. The new text must not launch a duplicate worker.

## Skills and migration evidence

`agent-skills/` contains portable copies of the four updated skills. They are installed locally under
the user's Codex skills directory; copying those folders to another machine preserves the workflow.
The shared GitHub contract and bundled helper live in `run-feature-agent-loop`. Version-1 Git-only
planning remains available when explicitly requested.

`migration.json` maps feature/task issues, Project items and all archived original paths/commits.
`archive/` contains historical input documents and the pre-migration GitHub inventory. These are
immutable provenance, not current launch instructions. Do not use an archive as an executable plan.
Unfinished source work, existing worker/control refs and the user's modified/untracked checkout are
preserved. Backlog planning refs can be retired only after archive and issue coverage verification
and an active-run reference audit.

Run the helper checks with:

```text
python tools/feature-agents/test_github_plan.py
```
