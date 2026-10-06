---
name: plan-feature-agents
description: Turn a feature overview into bounded GitHub parent and task issues with an agent execution contract and Project tracking. Preserve scope, dependencies, validation and delivery policy. Use for executable milestone planning or updating an existing GitHub plan; retain Git-only planning when the user explicitly requests it.
---

# Plan Feature Agents

Create a compact implementation plan without implementing the feature.

## Inputs

Use the feature overview already present in the conversation. Inspect the repository to replace assumptions with concrete paths, commands, conventions, tests, and integration points. Ask only for a missing decision that materially changes the plan.

Read [references/planning-artifacts.md](references/planning-artifacts.md) before writing the plan.

## Planning destination

Prefer GitHub Issues and Projects when requested or configured by the repository. Read [the shared GitHub contract](../run-feature-agent-loop/references/github-project-contract.md). Create or update one parent issue with the coordinator context and version-2 JSON `agent_plan`, and one complete task sub-issue per worker. Reuse existing identities, preserve unrelated issue content, add Project items and appropriate readiness/priority, and verify the published bodies and native parent links. Keep deferred ideas non-executable. An overview spanning phases may link phase parents without its own `agent_plan`.

Use the workload, delivery and validation rules below, but replace Git-only workflow steps 4–5 and 10–13 with GitHub issue preparation/publication. No permanent planning branch or backlog worktree is needed. Publish only within the user's GitHub planning authority; otherwise prepare local reviewable bodies. Shared technical documents may be delivered through a normal docs PR when needed. GitHub planning does not authorize feature implementation, PR merging or deployment.

The workflow below is the compatibility path for an explicit Git-only request; existing active Git-based runs keep their original contracts.

## Workflow

1. Locate the repository root and read applicable instructions such as `AGENTS.md`.
2. Inspect only architecture, tests, branch policy, remotes, and default-branch information relevant to the milestone.
3. Record the starting branch, source `HEAD`, and `git status --short`. Preserve all pre-existing user changes.
4. Create a planning branch named `codex/plan-<slug>`, adding a suffix on collision. Use a separate temporary worktree if switching would disturb existing changes. Record the exact absolute path when this workflow creates one.
5. Create `docs/feature-plans/<slug>/` unless repository conventions require another location under root `docs/`.
6. Select the smallest end-to-end milestone that produces usable or independently verifiable value.
7. Decompose it into bounded vertical slices with explicit dependencies and non-overlapping primary ownership.
8. Classify each task as `default-branch-pr` or `integration-only`, and define how its exact launch base will be resolved.
9. Define targeted checks, critical E2E scenarios, and the coordinator-owned integration gate.
10. Write one compact prompt per worker plus `README.md`. Put shared context and the review contract in the README.
11. Stage only the new plan directory. Never use broad staging.
12. Verify every staged path begins with `docs/`, commit the plan, then verify every path changed by the planning branch begins with `docs/`.
13. If this workflow created a temporary planning worktree, remove that worktree using the guarded cleanup procedure below and retain the planning branch at the verified plan commit.

## Workload Budget

Default to one focused coordination cycle:

- Use 1 to 3 worker tasks and no more than 2 waves.
- Give each worker one primary outcome and normally no more than 3 to 5 primary files.
- Prefer vertical slices over separate API, UI, test, documentation, and integration agents.
- Keep each worker prompt near 600 words or fewer.
- Require 1 to 3 logical commits per worker.
- Assign targeted checks to workers and broad checks to the coordinator.
- Avoid standalone test, documentation, cleanup, or integration tasks unless they require substantial implementation.
- Exclude speculative refactors, optional hardening, and unrelated cleanup.
- If the whole feature does not fit, plan only Phase 1 and list the rest as a non-executable deferred backlog.

Exceed the budget only when the user requests a comprehensive plan or the smallest safe milestone cannot fit. Explain the exception.

## Delivery Classification

Prefer early default-branch PRs for independently safe slices even when the entire feature is unfinished.

Classify a task as `default-branch-pr` only when it:

- is deployable and testable by itself;
- has no runtime dependency on unmerged work;
- preserves backward compatibility and safe migrations;
- introduces no incomplete public contract;
- hides unfinished user behavior behind a disabled feature flag when needed;
- has a safe rollback path.

Otherwise classify it as `integration-only`.

Use `latest-default` as the base policy for independent work and work whose prerequisites have landed on the default branch. Use `integration-tip` when a task depends on accepted but not default-branch-safe work. Record the exact base commit when the coordinator launches the worker; do not pretend a moving branch name is immutable.

Planning a PR does not authorize pushing, opening, or merging one. Put the intended destination in the handoff so the review invocation can authorize those actions explicitly.

## Planning Rules

- Make each assignment executable using its prompt and coordinator README without hidden chat context.
- Tell the coordinator to supply both documents directly or provide an explicit readable planning ref and path; do not assume plan files exist in a source-based worker branch.
- Assign unique branch and sibling worktree names.
- Require workers to preserve scope, run targeted checks, review the complete diff, and report commits and risks.
- Put an essential shared contract in an earlier wave only when later work cannot proceed without it.
- Create an integration task only when integration requires source implementation.
- Do not implement source changes, create worker worktrees, execute prompts, or perform remote PR actions during planning.

## Git Safety

- Treat existing modifications and untracked files as user-owned.
- Add and commit only the generated plan directory.
- Do not use destructive Git commands, broad staging, forced branch changes, or cleanup commands other than removing the exact temporary planning worktree created by this workflow.
- If no root `docs/` exists, create it only when repository instructions permit; otherwise ask for the documentation location.
- Inspect and update an existing plan safely rather than overwriting it blindly.

## Remove the Temporary Planning Worktree

Run cleanup only when this workflow created a separate planning worktree. Never remove the original, user-provided, current, worker, integration, review, or pre-existing worktree.

Before removal:

1. Confirm the planning commit exists and every changed path from the source base to that commit is under `docs/`.
2. Confirm the planning branch points to that exact commit.
3. Confirm `git status --short` in the temporary worktree is empty.
4. Resolve the recorded absolute path and confirm it exactly matches an entry in `git worktree list --porcelain`.
5. Confirm the path is not the repository root, original worktree, current process directory, or any broad parent directory.
6. Leave the temporary worktree before removing it.

Then run `git worktree remove <exact-absolute-path>` without `--force`, from another valid repository worktree. Re-list worktrees to confirm the path is gone, then verify the planning branch still exists and still points to the plan commit.

If any check or removal fails, do not force deletion or delete the branch. Retain both, report the exact reason, and provide the safe manual next step.

## Final Response

For GitHub planning, report Project/parent/task links, milestone, tasks/waves, readiness, dependencies, delivery/base policies, checks, E2E and deferred scope, and readback verification. For explicit Git-only planning, report the branch/commit/path and guarded temporary-worktree cleanup as before. Preserve pre-existing state in either mode.
