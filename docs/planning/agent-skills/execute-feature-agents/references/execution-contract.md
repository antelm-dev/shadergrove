# Feature Execution Contract

For version-2 GitHub runs, obtain the review contract from the committed `snapshot.json.agent_plan` and frozen issue files. Add Project/parent/task URLs, snapshot path/hash and exact snapshot artifact ref/commit to execution records and launch packets. Use that ref/commit in the existing planning identity fields. The source launch SHA remains separately resolved. See [the shared GitHub contract](../../run-feature-agent-loop/references/github-project-contract.md). Preserve version-1 active lineages.

## Purpose and Boundary

Execution converts planned prompts into candidate commits. It verifies provenance and handoff completeness, not code correctness or delivery safety.

The three stages exchange durable contracts:

```text
plan-feature-agents
  -> planning README, worker prompts, review_contract
execute-feature-agents
  -> exact bases, candidate tips, checks, execution_contract
review-feature-agents
  -> review reports, delivery decisions, fix prompts
  -> execute-feature-agents for a refreshed fix round when rejected
```

## Execution Artifact

Store one immutable round record under the existing plan directory:

```text
docs/feature-plans/<feature-slug>/
|-- README.md
|-- 01-<task>.md
`-- executions/
    |-- round-1.yaml
    `-- round-2.yaml
```

Use this schema, omitting irrelevant optional fields rather than inventing values:

```yaml
execution_contract:
  milestone: archive-project-phase-1
  round: 1
  state: ready-for-review
  planning_ref: codex/plan-archive-project
  planning_commit: '<sha>'
  planning_state_ref: codex/plan-archive-project
  planning_state_commit: '<externally-resolved-docs-only-sha>'
  workflow_state: docs/feature-plans/archive-project/workflow/state.yaml
  source_base: '<sha>'
  default_branch: master
  integration_branch: codex/integrate-archive-project
  started_at: '<ISO-8601>'
  completed_at: '<ISO-8601>'
  candidates:
    - task: '01'
      prompt: docs/feature-plans/archive-project/01-service.md
      wave: 1
      base_policy: latest-default
      launch_base: '<immutable-sha>'
      branch: codex/archive-project-01
      worktree: '<absolute-path>'
      tip: '<candidate-sha>'
      status: ready-for-review
      commits: ['<sha>']
      changed_paths:
        - src/archive-service.ts
        - tests/archive-service.test.ts
      checks:
        - command: npm test -- archive-service
          result: passed
          exit_code: 0
      acceptance:
        AC-API: addressed
        AC-AUTH: addressed
      deviations: []
      risks: []
  not_launched: []
```

For a fix candidate, also record the rejection provenance:

```yaml
review_ref: codex/review-archive-project
review_commit: '<commit-containing-fix-prompt>'
fix_prompt: docs/feature-plans/archive-project/fixes/01-round-1.md
rejected_branch: codex/archive-project-01
rejected_tip: '<rejected-sha>'
old_base: '<old-launch-base>'
replay_range: '<old-base>..<rejected-tip>'
replay_mapping:
  '<old-commit>': '<replayed-commit>'
```

Verify that `review_commit` is reachable from `review_ref` and contains the exact fix-prompt path before launching. Base the fix round's execution-control branch on that review commit so planning, earlier execution, review findings, and the new execution record form one auditable docs-only lineage.

Allowed round states are `ready-for-review`, `partially-ready`, `execution-failed`, and `blocked`. Allowed candidate states are `ready-for-review`, `execution-failed`, and `blocked`.

Do not call a candidate `ready-for-review` when its identity, base, tip, worktree state, or evidence cannot be verified. A known failing check may be recorded as `ready-for-review` only when the plan or reviewer expects review of that failure and the evidence is complete; otherwise use `execution-failed`.

## Worker Launch Packet

Every worker receives all of the following without relying on hidden chat context:

1. Feature slug, milestone, task ID, and wave.
2. Coordinator README contents or exact planning ref and path.
3. Complete task or fix prompt contents or exact readable ref and path.
4. Exact launch-base commit and why it satisfies the base policy.
5. Assigned branch and absolute worktree.
6. Owned scope, exclusions, contracts, acceptance IDs, and checks.
7. Required commit count and final evidence format.
8. Prohibition on pushes, PRs, merges, destructive cleanup, and unrelated edits.

The worker must begin by checking its current directory, branch, `HEAD`, and clean status. If they do not match the packet, it stops without editing.

## Mechanical Readiness Gate

Before handoff, confirm:

- the candidate branch resolves to the reported tip;
- the candidate tip descends from the exact launch base;
- the worker worktree is clean and attached to the expected branch;
- the reported commit list agrees with the launch-base-to-tip range;
- changed paths agree with Git and do not contain an unexplained ownership escape;
- required commands and their actual outcomes are recorded;
- acceptance IDs use the planning contract's identifiers;
- deviations, failures, and environment limitations are explicit;
- the candidate ref and worktree remain available to review.

These checks establish auditability only. The reviewer independently inspects the full diff, tests sufficiency, correctness, security, compatibility, and delivery destination.

## Dependency Unlock Events

| Base policy                            | Required unlock event                                            |
| -------------------------------------- | ---------------------------------------------------------------- |
| `latest-default` without prerequisites | Exact refreshed default tip resolved immediately before launch   |
| `latest-default` with prerequisite     | Required PR merged and reachable from refreshed default tip      |
| `integration-tip`                      | Required candidate committed to integration and wave gate passed |
| Review fix                             | Reviewer records the latest valid base and replay range          |

Never unlock from a worker report, approval alone, an open PR, a CI result without merge reachability, or an uncommitted integration worktree.

## Round Transitions

```text
PLANNED
  -> BASE_RESOLVED
  -> WORKER_RUNNING
  -> WORKER_COMPLETE
  -> EXECUTION_VALIDATED
  -> READY_FOR_REVIEW

READY_FOR_REVIEW
  -> DO_NOT_MERGE / BLOCKED
  -> FIX_PROMPT
  -> REFRESHED_FIX_WORKER
  -> READY_FOR_REVIEW

READY_FOR_REVIEW
  -> MERGE / DEFAULT-BRANCH PR
  -> PR_MERGED
  -> DEFAULT_BASE_REFRESHED

READY_FOR_REVIEW
  -> MERGE / INTEGRATION ONLY
  -> INTEGRATED
  -> WAVE_GATE_PASSED
```

Execution owns transitions through `READY_FOR_REVIEW`. Review owns every decision and transition after it, except that execution implements a review-authored fix prompt as a new round.

## Review Handoff

Provide:

- planning ref, planning commit, and plan path;
- execution ref, execution commit, and artifact path;
- candidate task, branch, exact tip, and exact launch base;
- comparison range `<launch-base>..<candidate-tip>`;
- delivery classification and base policy from the plan;
- commits, changed paths, checks, and acceptance IDs;
- worktree path and clean-status evidence;
- deviations, known failures, risks, and environment limitations;
- for a fix round, the review ref and commit, fix-prompt path, rejected tip, old base, replay range, and commit mapping;
- tasks withheld from review and their blockers.

Do not state `MERGE`, `DO NOT MERGE`, `DEFAULT-BRANCH PR`, or `INTEGRATION ONLY` as an execution decision. Those labels belong to the reviewer, except when quoting the plan's intended delivery.
