# Planning Artifact Contract

For GitHub planning use [the shared GitHub contract](../../run-feature-agent-loop/references/github-project-contract.md): parent issue = coordinator README; sub-issues = worker prompts; fenced JSON `agent_plan` = version-2 review contract. The layout and YAML examples below describe explicit Git-only plans and the immutable local execution snapshot, not permanent backlog branches. Preserve the same scope, delivery, acceptance and base rules in either representation.

## Layout and Scope

```text
docs/feature-plans/<feature-slug>/
|-- README.md
|-- 01-<task-slug>.md
`-- 02-<task-slug>.md
```

Plan the smallest end-to-end milestone with 1 to 3 prompts and at most 2 waves. Put shared context and deferred work in `README.md`. Do not create execution instructions for deferred items.

Prefer one worker implementing a coherent path across necessary layers over separate layer-based workers. Do not add speculative architecture, generic hardening, or unrelated cleanup.

## Worker Prompt

Keep each prompt near 600 words or fewer. Require the worker to read the coordinator README supplied with the prompt. Include:

1. **Mission** - one primary outcome.
2. **Launch base** - base policy, exact base placeholder, and prerequisites.
3. **Isolation** - unique branch and sibling worktree, with a clean initial status.
4. **Context** - only necessary files, APIs, conventions, and instructions.
5. **Owned scope** - normally 3 to 5 primary files or one narrow boundary.
6. **Required work** - milestone-critical behavior and edge cases.
7. **Out of scope** - deferred and separately owned work.
8. **Contracts** - interfaces or assumptions consumed or changed.
9. **Verification** - targeted checks and acceptance IDs.
10. **Delivery** - intended destination, feature flag, and independent-deployment conditions.
11. **Commit discipline** - 1 to 3 logical commits and a final evidence report.

Use adaptable worktree commands:

```text
git worktree add <absolute-sibling-path> -b codex/<feature>-<task-id> <exact-launch-base>
cd <absolute-sibling-path>
git status --short --branch
```

## Coordinator README

Keep `README.md` compact and include:

- Feature goal, current milestone, assumptions, and non-goals.
- Planning ref and instructions for giving workers the README and their prompt.
- Source base, default branch, integration branch, and remote when known.
- Shared contracts and acceptance criteria with stable IDs.
- Task table, dependencies, branches, intended destinations, and base policies.
- At most 2 execution waves and their gates.
- Targeted checks, aggregate checks, and critical E2E scenarios.
- Worktree conventions and worker completion evidence.
- PR policy, integration policy, conflict ownership, and cleanup timing.
- Deferred backlog without executable prompts.

Add a machine-readable handoff block:

```yaml
review_contract:
  milestone: archive-project-phase-1
  planning_ref: codex/plan-archive-project
  source_base: '<sha>'
  default_branch: master
  integration_branch: codex/integrate-archive-project
  tasks:
    - id: '01'
      branch: codex/archive-project-01
      depends_on: []
      acceptance: [AC-API, AC-AUTH]
      checks: ['npm test -- archive-service']
      delivery: default-branch-pr
      base_policy: latest-default
      feature_flag: archive_projects
    - id: '02'
      branch: codex/archive-project-02
      depends_on: ['01']
      acceptance: [AC-UI]
      checks: ['npm test -- archive-dialog']
      delivery: integration-only
      base_policy: integration-tip
  integration_checks: ['npm test']
  e2e_scenarios:
    - 'owner archives a project'
    - 'non-owner cannot archive'
  deferred: ['restore-project']
```

Use actual repository values. Omit irrelevant optional fields rather than inventing them.

## Base and PR Rules

- Resolve and record an exact launch commit for every worker.
- After a prerequisite PR merges, refresh the default branch before launching dependents with `latest-default`.
- Use the integration tip only for dependencies that have not safely landed on the default branch.
- Mark a task `default-branch-pr` only when it is safe to deploy alone. Otherwise use `integration-only`.
- Do not treat opening a PR as integration. Require the PR to be merged and its result reachable from the updated target branch.
- Do not authorize remote actions inside the plan. State the authorization phrase the coordinator should use, such as: `Review completed tasks and open or merge eligible PRs`.

## Planning Worktree Lifecycle

The planning branch is the durable artifact. A separate planning worktree created only to protect the user's current checkout is temporary.

After the plan commit:

- verify the branch points to the recorded plan commit;
- require the temporary worktree to be clean;
- verify its exact absolute path against `git worktree list --porcelain`;
- remove it without force from another repository worktree;
- confirm the worktree disappeared and the planning branch remains.

Do not remove a worktree that predates the workflow or belongs to a worker, reviewer, integration branch, current process, or user checkout. On any ambiguity, retain it and report the blocker.

## Quality Review

Confirm:

- Current milestone criteria map to tasks and checks; deferred criteria are explicit.
- The workload budget is respected or an exception is explained.
- Each task has one primary outcome and clear ownership.
- Shared context appears once in the README.
- Every task has a delivery classification and base policy.
- Default-branch PR tasks are independently safe.
- Dependent tasks name the event that unlocks them: PR merged or integration gate passed.
- Critical E2E scenarios are explicit.
- Prompts, branches, acceptance IDs, checks, and handoff YAML agree.
- No generated or staged path lies outside root `docs/`.
- Any temporary planning worktree created by the workflow is clean, removed without force, and its planning branch remains at the verified commit.
