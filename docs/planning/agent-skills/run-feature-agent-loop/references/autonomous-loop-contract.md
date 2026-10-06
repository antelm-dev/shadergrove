# Autonomous Feature Loop Contract

## Contents

1. Durable state
2. Authority model
3. State transitions
4. Final integration delivery
5. Control lineage
6. Recovery rules
7. Terminal states

## Durable State

For new GitHub runs use `workflow.version: 2`, `planning_source: github-issues`, and a `github` mapping containing `project_url`, `parent_issue`, task-ID-to-issue URLs, `snapshot_path`, and `snapshot_manifest_sha256`. Planning lineage points to the exact committed snapshot artifact, not a permanent backlog planning branch. Add `pending_sync: []` for failed/unauthorized display updates. Preserve all existing authority, state-parent, source-base, candidate, retry and delivery fields below. Existing active version-1 runs retain their original lineage and launch packet. Read [github-project-contract.md](github-project-contract.md) for freezing, progress mapping, closure and recovery.

Store one current state document under the plan directory:

```text
docs/feature-plans/<feature-slug>/workflow/state.yaml
```

Use this schema. Use actual values and omit inapplicable optional fields.

```yaml
workflow:
  version: 1
  run_id: archive-project-2026-08-10
  feature_slug: archive-project
  milestone: archive-project-phase-1
  delivery_target: default-merged
  status: RUNNING
  stage: REVIEWING
  round: 2
  updated_at: '<ISO-8601>'
  state_ref: codex/review-archive-project-2
  state_parent: '<review-artifact-commit>'
  previous_state_commit: '<prior-externally-resolved-state-commit>'

  authority:
    local_worktrees: true
    local_branches: true
    local_commits: true
    push_candidates: false
    open_draft_prs: false
    merge_default_prs: false
    merge_integration_to_default: false
    delete_remote_refs: false
    deploy: false

  limits:
    max_fix_rounds_per_task: 3
    max_total_fix_rounds: 6
    max_parallel_workers: 3

  counters:
    total_fix_rounds: 1

  lineage:
    planning:
      ref: codex/plan-archive-project
      artifact_commit: '<sha>'
    execution:
      ref: codex/execute-archive-project-2
      artifact_commit: '<sha>'
    review:
      ref: codex/review-archive-project-2
      artifact_commit: '<sha>'
    integration:
      ref: codex/integrate-archive-project
      tip: '<sha>'

  tasks:
    '01':
      wave: 1
      status: PR_OPEN
      fix_rounds: 0
      launch_base: '<sha>'
      candidate_tip: '<sha>'
      review_tip: '<sha>'
      pr_url: 'https://example.invalid/pr/142'
      next_event: PR_MERGED
    '02':
      wave: 2
      status: WAITING_FOR_INTEGRATION_TIP
      fix_rounds: 1

  integration_delivery:
    mode: pr
    source_ref: codex/integrate-archive-project
    source_tip: '<sha>'
    target_ref: origin/master
    reviewed_range: '<default-base>..<integration-tip>'
    pr_url: '<optional-url>'
    merge_commit: '<optional-sha>'
    reachable_from_refreshed_target: false

  blocker: null
  last_transition:
    from: READY_FOR_REVIEW
    to: PR_OPEN
    evidence: '<review-ref>:<review-commit>'
```

Every referenced commit must resolve and contain the stated artifact. Do not serialize the SHA of the commit containing `state.yaml`; a commit cannot contain its own identity. Resolve the effective current state commit externally with `git rev-parse <state_ref>`, verify that tip contains this exact state file, and require its first parent to equal `state_parent`. The next stage starts from that externally resolved state commit so the docs-only history remains linear.

Use these workflow stages: `PLANNING`, `EXECUTING`, `REVIEWING`, `FIXING`, `WAITING_FOR_GATE`, `DELIVERING_INTEGRATION`, and `TERMINAL`.

Use these task statuses consistently: `PLANNED`, `READY`, `EXECUTING`, `READY_FOR_REVIEW`, `FIX_REQUIRED`, `FIXING`, `APPROVED_LOCAL`, `PR_OPEN`, `PR_MERGED`, `INTEGRATED`, `WAITING_FOR_DEFAULT`, `WAITING_FOR_INTEGRATION_TIP`, `COMPLETE`, and `BLOCKED`.

One review set corresponds to one committed execution artifact and may contain multiple candidates. One independent reviewer may process the set, but it must preserve per-candidate comparison ranges, findings, decisions, destinations, and reports.

## Authority Model

Record an action as true only from explicit user authority or the local authority inherent in invoking this workflow.

| Action                                  | Default | Requirement                                       |
| --------------------------------------- | ------- | ------------------------------------------------- |
| Inspect repository and remotes          | Allowed | Workflow invocation                               |
| Create local branches/worktrees/commits | Allowed | Workflow invocation                               |
| Run tests and local integration         | Allowed | Workflow invocation                               |
| Push candidate                          | Denied  | Explicit push or PR authority                     |
| Open draft PR                           | Denied  | Explicit PR authority; also permits required push |
| Merge default-branch PR                 | Denied  | Explicit merge authority                          |
| Merge integration into default          | Denied  | Explicit integration-delivery authority           |
| Delete remote refs                      | Denied  | Explicit deletion authority                       |
| Deploy or mutate production             | Denied  | Explicit environment-specific authority           |

Later user instructions may expand or revoke authority. Persist the change with its source wording before acting. Revocation applies immediately. Never infer one remote permission from another, except that opening a PR necessarily permits pushing its exact reviewed branch.

When calling the review stage:

- With no remote authority, state `review-only/no external writes` explicitly.
- With draft-PR authority, state that pushing the exact reviewed candidate and opening a draft PR are authorized.
- With merge authority, name the allowed target and require CI, reviews, and branch protection to pass.

## State Transitions

Select transitions from repository evidence, not optimism:

| Current evidence                                               | Next stage or state                                   |
| -------------------------------------------------------------- | ----------------------------------------------------- |
| No committed plan                                              | `PLANNING`                                            |
| Valid plan and dependency-ready tasks                          | `EXECUTING`                                           |
| Execution artifact with exact candidates                       | `REVIEWING`                                           |
| `DO NOT MERGE` plus committed fix prompt below limits          | `FIXING`                                              |
| `MERGE / INTEGRATION ONLY` plus passed wave gate               | `INTEGRATED`                                          |
| `MERGE / DEFAULT-BRANCH PR`, remote denied                     | `AWAITING_REMOTE_AUTHORIZATION`                       |
| Draft PR opened, merge denied and merge is required            | `AWAITING_MERGE_AUTHORIZATION`                        |
| Merge authorized, required checks or reviews pending           | `WAITING_FOR_GATE`                                    |
| Required approval cannot be supplied by Codex                  | `AWAITING_EXTERNAL_APPROVAL`                          |
| PR merge reachable from refreshed default                      | `DEFAULT_BASE_REFRESHED`                              |
| Final integration gate passes and default delivery is required | `DELIVERING_INTEGRATION` or an authorization terminal |
| Integration delivery merge reachable from refreshed default    | `COMPLETE` when all other target criteria pass        |
| Ready tasks remain after a gate                                | `EXECUTING`                                           |
| Final gate and recorded delivery target both pass              | `COMPLETE`                                            |
| Fix limit would be exceeded                                    | `RETRY_LIMIT_REACHED`                                 |
| Concrete unresolved ambiguity prevents safe progress           | `BLOCKED`                                             |

Continue independent ready work before choosing an authorization or wait terminal for the whole run.

## Final Integration Delivery

For `DELIVERING_INTEGRATION`, require a fresh aggregate review of the exact default-base-to-integration-tip range. Follow repository policy; prefer a protected PR to the default branch. Do not use a direct merge or push unless repository policy permits it and the user explicitly authorized that mechanism. Record the source tip, target tip, delivery method, PR when applicable, merge commit, required checks and reviews, and refreshed-target reachability. Never infer integration from a passing gate alone.

## Control Lineage

Use one docs-only chain:

```text
planning artifact
  -> coordinator state
  -> execution artifact
  -> coordinator state
  -> review report or fix prompt
  -> coordinator state
  -> next execution artifact
```

Stage product commits remain on candidate, validation, integration, or default-bound branches. Never merge them into this chain.

After each verified stage:

1. Check out the stage's clean control worktree.
2. Update only `workflow/state.yaml`.
3. Stage that exact path and verify it begins with root `docs/`.
4. Commit one state transition.
5. Record the new tip as the next stage's control base.

If the specialist stage removed its temporary control worktree, create a new guarded temporary docs-control worktree at the verified stage commit, commit state, verify it, and remove only that exact clean worktree without force. Retain the branch.

## Recovery Rules

On resume:

1. Enumerate matching control refs and read state at their exact tips with `git show` rather than switching branches.
2. Resolve each candidate state commit from its recorded `state_ref`, then verify its `state_parent`, `previous_state_commit`, artifact commits, candidate tips, PRs, merges, and integration tip.
3. Prefer the unique state commit that descends from its recorded previous state and every earlier artifact in the lineage.
4. Stop if two active state tips diverge, a recorded commit moved, a worktree is dirty or ambiguously owned, or remote state contradicts the record.
5. If Git proves a single later transition that was not persisted, write a recovery commit and mark `last_transition.evidence` as inferred from the exact source.
6. Resume from the first incomplete transition; never repeat an external action whose result already exists.

An open PR is not a merge. A passing check is not merge reachability. A worker report is not candidate identity. Re-establish each fact from its authoritative source.

## Terminal States

- `COMPLETE`: Current milestone criteria, aggregate checks, required E2E, and the recorded delivery target all pass. For `default-merged`, the delivered commits are reachable from the refreshed default branch.
- `AWAITING_REMOTE_AUTHORIZATION`: Approved local work needs an ungranted push or PR action.
- `AWAITING_MERGE_AUTHORIZATION`: An approved PR or integration result needs an ungranted merge.
- `AWAITING_EXTERNAL_APPROVAL`: Branch protection, required human review, credential, or protected-environment approval is pending.
- `RETRY_LIMIT_REACHED`: Another fix launch would exceed a configured limit.
- `BLOCKED`: A concrete ambiguity, missing prerequisite, or unsafe repository condition prevents further in-scope work.
- `CANCELLED`: The user explicitly ends the run.

Persist the terminal state before responding whenever a safe docs-only control path remains available. Never label a run `COMPLETE` merely because no authorized action remains.
