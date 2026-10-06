---
name: review-feature-agents
description: Review and test feature worker branches, find correctness, security, regression, and integration bugs, give separate code-quality and delivery recommendations, add bounded E2E coverage, open or merge authorized pull requests for independently safe slices, integrate dependent work, and create refreshed fix prompts for rejected branches. Use when planned worker branches are ready, accepted work may safely enter the default branch before the whole feature is complete, failed work must be carried onto the latest valid base, or a review-fix-PR loop is required.
---

# Review Feature Agents

Run the review, testing, correction, PR, and integration half of a planned feature workflow.

Read [references/review-loop.md](references/review-loop.md) before starting.

For GitHub input, read [the shared GitHub contract](../run-feature-agent-loop/references/github-project-contract.md). Review against the execution run's committed issue snapshot and `snapshot.json.agent_plan`, not newly edited live scope. Verify hashes and snapshot ancestry; retain exact issue IDs in reports/fix rounds/PRs. Legacy active version-1 handoffs continue unchanged. Report material live drift and replan unstarted work explicitly without rewriting reviewed candidates.

When GitHub synchronization is authorized, the coordinator publishes review/fix/delivery evidence and Project progress. Keep pending review/CI/merge work In Review, required corrections Blocked with their reason, and use Done/close only after the declared delivery target and gates pass. Link task issues in PRs; use closing keywords only for verified target-branch delivery. Every created PR must be attached to the Codex chat. Project update failures become pending sync receipts, never a reason to repeat implementation or merge.

## Establish the Review Set

1. Locate the repository root and read applicable instructions.
2. Load the plan README, worker prompts, and `review_contract`. When execution supplied a durable handoff, also load its exact execution ref, artifact commit, artifact path, and `execution_contract`; verify the commit contains the artifact and every candidate identity agrees with Git. When `run-feature-agent-loop` supplied a later execution state commit, resolve it externally from its state ref and verify it descends from the artifact commit, changes only docs, and contains the current workflow state.
3. Resolve the default branch, remote, source base, integration branch, task dependencies, intended delivery, checks, acceptance IDs, and E2E scenarios.
4. Record current branches, exact tips, worktrees, remotes, and statuses. Preserve user changes.
5. Reject ambiguous branches and uncommitted candidate work.
6. Use isolated clean worktrees for review, validation, and integration.

If the handoff is absent, reconstruct the minimum contract and label every inferred field.

## Keep Histories Separate

- Commit reports and fix prompts on `codex/review-<slug>` or another docs-only control branch. Create the control branch from the exact execution artifact commit for a standalone round, or from the externally resolved execution state commit when `run-feature-agent-loop` has appended workflow state. Use the verified planning artifact commit or externally resolved planning state commit only for a legacy handoff without an execution artifact. Confirm ancestry and that intervening control changes are docs-only. Confirm the plan directory is present. On a branch-name collision, do not reuse an ambiguous or stale branch; inspect it and add a unique suffix unless it is the explicitly recorded clean continuation point.
- Keep dependent accepted source changes on `codex/integrate-<slug>`.
- Route independently safe slices through PRs to the repository's default branch.
- Never merge implementation into the control branch.
- Never ship review artifacts with product code unless explicitly requested.

## Review and Test Each Candidate

Review the entire delta from the recorded launch base to the exact candidate tip:

1. Inspect commit history, changed paths, diff statistics, `git diff --check`, and the complete diff.
2. Compare behavior with scope, contracts, dependencies, acceptance IDs, and intended delivery.
3. Inspect surrounding code and tests, not isolated hunks.
4. Search for correctness defects, regressions, edge cases, unsafe error handling, authorization and privacy failures, state or concurrency bugs, compatibility issues, migration hazards, and operational gaps as relevant.
5. Confirm tests cover changed behavior and failure paths.
6. Run targeted checks. Run broader checks when risk or repository policy requires them.
7. Recheck the tip before deciding.

Do not modify the candidate branch during review. Do not block on style preferences or speculative improvements.

## Make Two Decisions

Record:

1. **Code decision**
   - `MERGE` when no blocking finding remains and required evidence passes.
   - `DO NOT MERGE` when a verified blocker, required-check failure, material scope violation, unresolved dependency, or missing milestone criterion remains.
2. **Delivery destination**
   - `DEFAULT-BRANCH PR` when the slice is independently safe.
   - `INTEGRATION ONLY` when good code still depends on unfinished work.
   - `BLOCKED` for every `DO NOT MERGE` result.

Write findings first, ordered by severity, with exact evidence, impact, and the smallest acceptable correction. Distinguish candidate defects from pre-existing failures.

Re-evaluate delivery safety rather than trusting the plan blindly. A default-branch PR requires standalone tests, no dependency on unmerged behavior, backward-compatible contracts and migrations, hidden incomplete UX when necessary, and safe rollback.

## Add Bounded E2E Evidence

Run existing E2E coverage required by the review contract. When a critical scenario lacks coverage, the review worker may author tests only when:

- existing E2E infrastructure is usable;
- 1 to 3 critical-path tests are sufficient;
- no new framework, service, credential, or major fixture is required;
- only test code and minimal existing test fixtures change.

Create a separate validation branch and worktree from the reviewed candidate tip, such as `codex/<slug>-<task>-e2e-r<n>`. Never edit the original candidate. Review the test diff and treat the validation tip as the new candidate.

If the new test exposes a product bug, do not repair product code as the reviewer. Issue `DO NOT MERGE` and create a fix prompt based on the validation tip so the regression test is preserved. If test authoring exceeds the bounds, create a dedicated prompt instead. Missing E2E is blocking only when required by the contract or necessary to establish material safety.

## Route an Approved Candidate

### Default-branch PR

After a `MERGE` / `DEFAULT-BRANCH PR` decision, automatically push the reviewed final candidate and open a **draft** PR. Treat invocation of this workflow as authorization for those two actions unless the user explicitly requests review-only/no external writes. Never enable auto-merge or merge without separate explicit authorization.

1. Refresh remote state and confirm the planned target is still the default branch.
2. If the candidate is stale, create a new refresh branch from the latest default tip and replay the reviewed range; never rewrite the reviewed branch in place.
3. Re-run affected checks and review the refreshed delta.
4. Push the exact final candidate and open a focused PR containing acceptance IDs, findings status, checks, E2E evidence, feature-flag state, and reviewed commit.
5. Merge only when explicitly authorized and required CI, reviews, and branch protections pass. Never bypass protection.
6. Verify the merged result is reachable from the updated default branch, then record the PR and merge commit.
7. Tell future independent workers to resolve a new exact base from the updated default branch.

Opening a PR is not integration. Do not unlock dependent work until the required commits are actually in its declared base.

### Integration only

Trial-merge the exact reviewed candidate into a clean integration worktree. If the declared integration branch does not yet exist, create it from the first accepted integration-only candidate's exact launch base and record that initialization commit. If it already exists, verify its identity, tip, clean worktree state, and provenance from the recorded integration lineage; never reuse a colliding or ambiguous branch. Abort on conflicts or failed gates and create a fix prompt. Commit only after the wave gate passes. Record the resulting exact integration tip so execution can unlock dependents. Do not merge the integration branch into the default branch without explicit authorization.

## Create a Refreshed Fix Round

For `DO NOT MERGE`:

1. Preserve the rejected branch and exact commit unchanged.
2. Resolve the latest valid base:
   - updated default tip when prerequisites have landed there;
   - exact integration tip when unmerged dependencies remain.
3. Write a fix prompt at `docs/feature-plans/<slug>/fixes/<task>-round-<n>.md`.
4. Tell the fix agent to create a new branch and worktree from the latest valid base, then replay the rejected commit range in order before applying corrections.
5. Record old base, rejected tip, new base, replay method, and any commit mapping.
6. Require regression tests, targeted checks, 1 to 3 logical commits, and final evidence.
7. Commit only docs paths on the control branch.
8. Record the exact review control ref and commit containing the fix prompt so execution can verify its provenance and base its next docs-only control round on that commit.

Review the complete refreshed result against its new base. Never force-update or rebase the recorded rejected branch.

## Finish and Clean Up

After each wave, run its gate before launching dependents. After the milestone:

1. Run aggregate tests and required E2E scenarios.
2. Compare the delivered result with current milestone criteria, excluding explicit deferred scope.
3. Review interactions across branches and issue a final two-axis decision.
4. Create an integration-level fix prompt when rejected.
5. Report merged PRs, integration commits, remaining integration-only work, and exact bases for future agents.

When the final accepted milestone resides on the integration branch and the recorded delivery target requires the default branch, perform a fresh aggregate review of the exact refreshed-default-to-integration-tip range. Follow repository policy and prefer a protected PR. Push or open that PR only when authorized, and merge only with separate explicit authority after required CI, reviews, and protections pass. Verify the delivered commits are reachable from the refreshed default branch. Otherwise report the exact missing authority or external gate; a passed integration gate alone is not delivery.

Clean up only after proof:

- For a default-branch PR, wait until the merge is verified on the updated target.
- For integration-only work, wait until the final aggregate gate passes.
- Require a clean worker worktree and exact commit or patch-equivalence proof.
- Remove worktrees without force and branches with safe deletion first.
- Retain rejected, dirty, ambiguous, planning, control, integration, default, protected, and unverified branches.
- Never delete remote branches unless explicitly requested.

## Final Response

Lead with code decision and delivery destination. Report findings, exact reviewed and delivered commits, checks and E2E evidence, PR URLs and status, integration results, refreshed fix prompts, cleanup, residual risks, and the next valid base for every pending task.
