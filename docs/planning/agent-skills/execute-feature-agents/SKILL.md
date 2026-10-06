---
name: execute-feature-agents
description: Execute GitHub issue plans or legacy committed plans through frozen contracts, immutable launch bases, isolated workers and dependency gates. Record candidate and check evidence for independent review, including refreshed fix rounds. Does not plan features or decide code approval and delivery.
---

# Execute Feature Agents

Turn a committed feature plan into immutable, reviewable candidate branches. Coordinate implementation without reviewing or shipping it.

Read [references/execution-contract.md](references/execution-contract.md) before starting.

For GitHub input, first read [the shared GitHub contract](../run-feature-agent-loop/references/github-project-contract.md). Reconcile existing runs; never restart a task already assigned. Freeze the selected parent and task issues with `../run-feature-agent-loop/scripts/github_plan.py` on a temporary docs-only run/control branch and commit only that snapshot. Use `snapshot.json.agent_plan` as the review contract, its committed README/task files as the launch packet, and record the snapshot control ref/commit as planning identity in the steps below. Check live scope drift before launching unstarted work. Project status and issue closure do not unlock dependencies; prove commits in the selected launch base.

When Project synchronization is authorized, the coordinator moves launched tasks to In Progress and review-ready candidates to In Review, preserving exact issue IDs and evidence. Record pending sync on failures. Workers never write Projects. Legacy version-1 active runs remain on their existing control lineage.

## Establish the Execution Set

1. Locate the repository root and read applicable instructions such as `AGENTS.md`.
2. Locate the planning ref and `docs/feature-plans/<slug>/README.md`. Read the coordinator README, every prompt in the requested wave, and its `review_contract`. When `run-feature-agent-loop` supplied workflow state, verify its planning artifact commit and later planning state commit separately; resolve that state commit from the recorded state ref rather than from a self-reported SHA inside the state file.
3. Verify that task IDs, branches, dependencies, acceptance IDs, checks, delivery classifications, and base policies agree across the artifacts. Stop on a material ambiguity rather than inventing a contract.
4. Record the current branch, exact `HEAD`, worktrees, remotes, default branch, integration tip, and every worktree status. Preserve all user changes.
5. Create a docs-only control branch named `codex/execute-<slug>` from the exact verified planning artifact commit for a standalone initial round. Under `run-feature-agent-loop`, use the externally resolved planning state commit descended from that artifact commit and containing the current workflow state. For a fix round, use the externally resolved review state commit descended from the fix-prompt artifact commit. Add a suffix on collision and use an isolated control worktree when needed. Confirm the plan directory is present at the control base. Never mix execution records into implementation branches.

## Resolve an Immutable Launch

For each ready task, resolve its policy immediately before launch:

- `latest-default`: fetch or otherwise refresh repository state, then record the exact current default-branch commit.
- `integration-tip`: use the exact verified integration commit containing every required accepted dependency.
- Review fix: verify the fix prompt at an exact review control ref and commit, use the latest valid base selected there, record the rejected tip and replay range, and preserve the rejected ref unchanged.

Confirm that every prerequisite is reachable from the selected base. A draft or unmerged PR does not satisfy a dependency. Record the immutable launch commit in the execution artifact and worker instructions.

## Create Isolated Workers

1. Assign each task its planned unique branch and absolute sibling worktree path.
2. Confirm neither already exists. On collision, inspect it; never overwrite, reuse ambiguously, or force-delete it.
3. Create the branch and worktree from the exact launch commit and require a clean initial status.
4. Launch one subagent per ready task. Parallelize only tasks in the same wave whose ownership and dependencies do not overlap. Do not delegate a worker's task again.
5. Give the worker the coordinator README, its complete prompt, exact launch commit, branch, worktree, and instruction to work only inside that worktree. A source-based branch may not contain the plan, so supply the documents directly or by an explicit readable ref and path.

Worker invocation authorizes source edits, targeted checks, and 1 to 3 logical local commits in the assigned worktree. It does not authorize pushes, PRs, merges, destructive cleanup, or edits to another branch.

## Monitor and Accept the Worker Handoff

Wait for all workers in the wave. Require each to report:

- task ID, branch, absolute worktree, launch base, and final tip;
- commits and changed paths;
- checks with commands and outcomes;
- acceptance IDs addressed;
- deviations, unresolved risks, and preserved user state.

Mechanically validate the report against Git. Require the expected branch, a clean worktree, at least one candidate commit unless the prompt legitimately required no change, and a final tip descended from the recorded base. Inspect changed paths and commit range only to detect missing evidence, scope escape, or handoff inconsistency. Do not make a code-quality or delivery judgment.

Classify the execution result as `ready-for-review`, `execution-failed`, or `blocked`. A failed check may still be handed to review when the failure and evidence are complete; never misreport it as passing.

## Gate Waves

- Launch a dependent task only when its prerequisite exists in its declared base.
- For a `latest-default` dependency, wait until review verifies the prerequisite merged and refresh the default tip.
- For an `integration-tip` dependency, wait until review verifies the candidate integrated and the wave gate passed.
- Do not treat worker completion, review approval, or an open PR as integration.
- Re-resolve bases immediately before every later-wave or fix launch.

## Record and Hand Off

Write `docs/feature-plans/<slug>/executions/round-<n>.yaml` on the execution control branch using the schema in the reference. Stage only that file, verify every staged path begins with `docs/`, and commit it. Do not rewrite the planning branch.

Hand `review-feature-agents` the planning artifact commit and any later externally resolved planning state commit, execution ref and artifact commit, exact candidate branches and tips, launch bases, checks, acceptance coverage, dirty-state verification, and known limitations. For GitHub runs also pass parent/task issue URLs, Project URL, snapshot path/hash and exact snapshot commit. Stop after the handoff unless review is separately authorized; review may push and open draft PRs under its own contract.

When review returns a fix prompt, start a new execution round whose control lineage begins at the exact review commit containing that prompt. Create a new worker branch and worktree from the reviewer-selected source base, replay the rejected range as instructed, preserve the rejected branch unchanged, and record the old and new commit mapping.

## Safety and Cleanup

- Never edit, rebase, reset, force-update, or delete a candidate or rejected branch.
- Never use broad staging, forced worktree removal, or destructive Git commands.
- Retain worker worktrees and branches for review. Remove them only under the proof and cleanup rules of `review-feature-agents`.
- Remove only a temporary clean execution-control worktree created by this workflow, after its commit and branch are verified, using the same guarded checks required by the planning workflow. Retain the execution branch.
- Preserve pre-existing worktrees, branches, modifications, and untracked files.

## Final Response

Report the execution branch and commit, planning ref, milestone, completed waves, and every task's launch base, candidate tip, checks, acceptance coverage, and execution status. Identify tasks not launched and the exact dependency or ambiguity blocking them. Link the durable execution artifact, state whether the temporary control worktree was removed, confirm candidate worktrees were retained for review, and provide the exact review handoff.
