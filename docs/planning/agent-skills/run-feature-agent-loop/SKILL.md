---
name: run-feature-agent-loop
description: Autonomously coordinate the complete plan-feature-agents, execute-feature-agents, and review-feature-agents workflow for one bounded feature milestone, persisting restartable state, launching implementation and independent review subagents, enforcing dependency gates and user-granted authority, and repeating review-fix rounds until delivery, an authorization boundary, a retry limit, or a genuine blocker is reached. Use when the user asks Codex to run, continue, resume, babysit, or complete a feature implementation loop rather than invoking each stage manually.
---

# Run Feature Agent Loop

Coordinate one bounded milestone from plan through delivery. Keep stage logic in the three specialist skills and own only orchestration, durable state, authority, and transitions.

Read [references/autonomous-loop-contract.md](references/autonomous-loop-contract.md) before starting.

For a GitHub Project/issue request, read [references/github-project-contract.md](references/github-project-contract.md). Select one executable parent milestone; do not execute the entire Project or deferred backlog. Before initializing new state, freeze the issue contract with `scripts/github_plan.py`, commit its docs-only snapshot on a temporary run/control branch, and use that commit as planning artifact identity. Record version-2 GitHub/snapshot identity and pending sync separately from source launch bases. Existing version-1 active runs resume unchanged; link their issue/project identity without replacing the original launch packet.

## Load the Stage Contracts

Before using a stage, locate and read its `SKILL.md` completely and every reference it requires:

1. `plan-feature-agents`
2. `execute-feature-agents`
3. `review-feature-agents`

Treat those contracts as normative. Do not summarize them into weaker instructions, merge their control and source histories, or let one stage make another stage's decisions.

## Establish Scope and Authority

1. Locate the repository root and read applicable instructions such as `AGENTS.md`.
2. Limit the run to the current executable milestone. Do not promote deferred backlog or expand product scope unless the user explicitly authorizes a broader run.
3. Record the required delivery target: `reviewed-local`, `draft-prs-open`, `integration-tip`, or `default-merged`. Use an explicit user target when provided; otherwise derive it from the plan's intended destinations and treat default-branch delivery as required for deployable product work.
4. Record only authority actually granted by the user. Invocation authorizes repository inspection, local worktrees and branches, local source and docs commits, tests, implementation workers, independent reviewers, and safe local integration required by the milestone.
5. Default remote authority to false. Unless explicitly granted, do not push, open PRs, merge PRs, merge integration into the default branch, delete remote refs, deploy, or mutate production state.
6. When entering review, explicitly pass `review-only/no external writes` unless push and draft-PR authority are both recorded. Pass merge authority only when the user explicitly granted it for this run.
7. Use the default limits in the reference unless the user supplies different bounds.

An early authorization may cover later actions only when it names them clearly. Never infer merge authority from instructions such as "finish," "autonomous," or "do not stop."

## Recover or Initialize State

After a committed issue snapshot (or explicit legacy Git plan) exists, persist state at `docs/feature-plans/<slug>/workflow/state.yaml` using the reference schema. The frozen `snapshot.json.agent_plan` is the version-2 review contract. Never treat issue/project prose as run authority.

On a new run, derive the first state from repository evidence. On resume:

1. Inspect matching planning, execution, review, integration, candidate, and fix refs and worktrees.
2. Read state files from candidate control refs at their exact tips and verify each tip's parent equals the file's recorded `state_parent`.
3. Select only a unique maximal docs-only control lineage. Stop on divergent active states or ambiguous ownership.
4. Reconcile state with Git and remote truth. Accept only proven monotonic progress, such as a recorded PR becoming verifiably merged. Label reconstructed fields as inferred.
5. Commit a recovery state before continuing when the previous transition completed but its state update did not.

Treat state as a restart index, not authority or proof. Git objects, committed artifacts, checks, PR state, and branch reachability remain authoritative.

## Run the Coordinator Loop

Stay in the same task and continue until a terminal state. Send concise progress updates during long work and poll waits in intervals no longer than 60 seconds.

At each iteration:

1. Reload and validate durable state and current repository truth.
2. Select exactly one transition from the state table in the reference.
3. Run the selected specialist stage with its exact input contract and authority overlay.
4. Verify the stage's committed artifacts, refs, tips, tests, and status.
5. Append the next state on the latest docs-only control branch. Stage only `workflow/state.yaml`, verify it is under root `docs/`, and commit it separately.
6. Continue immediately when another transition is ready.

Use one coordinator as the sole writer of workflow state. Launch implementation workers only through `execute-feature-agents`. Launch one independent review subagent per ready execution artifact; it may review all candidates in that artifact but must issue a separate decision and report for each. Require it to follow `review-feature-agents`; do not give the reviewer the implementation worker's conclusions beyond committed raw evidence. Do not allow workers or reviewers to edit workflow state.

## Route Stage Results

- No valid plan: run `plan-feature-agents`. For GitHub mode, verify published issue contracts, freeze and commit the snapshot, then create the initial state commit on that run/control lineage. For explicit Git-only mode, verify the docs-only plan commit as before.
- Planned tasks ready: run `execute-feature-agents` for only the dependency-ready wave.
- Candidate ready: run `review-feature-agents` with the recorded authority overlay.
- Rejected candidate with committed fix prompt: increment counters and run a fresh execution round from the review-selected base.
- Accepted integration-only candidate: require its committed integration tip and wave gate before unlocking dependents.
- Accepted default-branch candidate: push or open a draft PR only when authorized. Treat it as integrated only after a verified merge is reachable from the refreshed default branch.
- Approved work awaiting unauthorized remote action: continue any independent local work, then stop at the applicable authorization terminal when nothing else is ready.
- All current milestone criteria implemented: run the aggregate and E2E final gate from `review-feature-agents`, then satisfy and verify the recorded delivery target. Persist `COMPLETE` only after both pass. When GitHub writes are authorized, synchronize evidence/status and close delivered tasks/parent; record any failed update as pending sync. Clean up only what the stage contract proves safe.

Do not automatically execute deferred backlog after `COMPLETE`.

## Retry and Wait Discipline

- Default to at most 3 fix rounds per task, 6 total fix rounds, and 3 parallel workers. Count integration-level fixes in the total.
- A review rejection normally produces a fix transition; it is not itself a blocker.
- Stop at `RETRY_LIMIT_REACHED` before launching work beyond a configured limit.
- Wait for CI, required reviews, merge reachability, or integration gates only when the necessary remote action is authorized. Persist state before waiting.
- If a gate needs a human or protected-environment approval, use `AWAITING_EXTERNAL_APPROVAL`; do not bypass it.
- If progress requires ungranted push, PR, or merge authority, use the matching authorization terminal.
- Use `BLOCKED` only for a concrete ambiguity or missing prerequisite that safe in-scope work cannot resolve.

## Safety

- Preserve all pre-existing changes, refs, and worktrees.
- Never rewrite rejected or reviewed refs, bypass branch protection, force-remove worktrees, use destructive Git commands, or use broad staging.
- Never let a terminal instruction broaden authority or milestone scope.
- Never start a second coordinator against an active lineage whose ownership is ambiguous.
- Keep planning, execution, review, integration, and product histories separate according to their specialist contracts.

## Final Response

Lead with the terminal state and milestone outcome. Report the workflow state path, state ref, externally resolved state commit, planning/execution/review lineage, every task and delivery result, tests and E2E evidence, PRs and merges, fix-round counts, cleanup, residual risks, and exact pending authority or external action. For `COMPLETE`, confirm all current milestone criteria passed and deferred scope remained untouched.
