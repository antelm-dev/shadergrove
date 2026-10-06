# Review, PR, and Fix Loop Contract

Version-2 GitHub review uses the same committed snapshot as execution, recording Project/parent/task URLs and snapshot path/hash/ref/commit in each report and fix prompt. Project synchronization and issue closure follow [the shared GitHub contract](../../run-feature-agent-loop/references/github-project-contract.md); display state never proves safe delivery. Retain version-1 active handoffs.

## Review Report

Store reports and fix prompts under the feature plan:

```text
docs/feature-plans/<feature-slug>/
|-- reviews/
|   |-- <task>-round-1.md
|   `-- integration-round-1.md
`-- fixes/
    `-- <task>-round-1.md
```

Each report contains:

- planning and execution refs, commits, and artifact paths used to establish the review set;
- candidate branch, exact tip, launch base, and comparison range;
- code decision and delivery destination;
- findings ordered by severity;
- acceptance coverage and scope;
- commands and outcomes;
- E2E evidence or limitation;
- refresh or replay mapping when applicable;
- PR target, URL, CI status, and merge commit when applicable;
- integration result, residual risks, and next valid base.

Commit reports and prompts only after verifying staged paths are under root `docs/`.

## Severity

- **P0 - Critical:** catastrophic loss, compromise, secret exposure, or system-wide outage. Always blocks.
- **P1 - High:** correctness, security, data integrity, or major supported-use regression. Always blocks.
- **P2 - Medium:** a real supported edge-case, contract, maintainability, or operational defect. Block when it violates criteria or safe delivery.
- **P3 - Low:** non-blocking improvement or narrow cleanup. Never reject solely for P3.

Attribute a check that cannot run to candidate code, repository state, environment, or missing dependency. Block only when missing evidence leaves material safety unverified.

## Delivery Matrix

| Code         | Delivery          | Meaning                                     |
| ------------ | ----------------- | ------------------------------------------- |
| MERGE        | DEFAULT-BRANCH PR | Correct and safe to deploy independently    |
| MERGE        | INTEGRATION ONLY  | Correct but dependent on unfinished work    |
| DO NOT MERGE | BLOCKED           | Verified correction or evidence is required |

Default-branch safety requires:

- standalone behavior and tests;
- no runtime dependency on unmerged work;
- backward-compatible schema, API, and migration behavior;
- disabled feature flag for incomplete exposed UX when needed;
- safe rollback and no incomplete public contract.

## Bounded E2E Branch

Use a validation branch from the exact reviewed tip:

```text
git worktree add <path> -b codex/<feature>-<task>-e2e-r<round> <reviewed-tip>
```

Add at most 1 to 3 critical tests with the existing harness. Change test code and minimal existing fixtures only. Review this additional diff. If tests pass, the validation tip replaces the earlier candidate for delivery.

If a test exposes a product defect, preserve the failing test and generate a product fix prompt from the validation tip. If E2E requires infrastructure, credentials, services, broad fixtures, or extensive coverage, generate a separate task instead.

## Fix Prompt and Base Refresh

Include:

1. Exact rejected branch, tip, and old launch base.
2. Latest valid base and why it is valid.
3. Commit range to carry forward.
4. New branch and worktree names.
5. Replay instructions using cherry-pick or a new-branch rebase without rewriting the rejected ref.
6. Blocking findings with file, symbol, evidence, expected behavior, and impact.
7. Regression tests and exact checks.
8. Scope exclusions and preserved valid behavior.
9. Required commit mapping and final evidence.
10. Exact review control ref, commit, and fix-prompt path that execution must verify before launching the fix.

Example:

```text
old base A -> rejected tip R
latest valid base B
new fix branch: B + replay(A..R) + corrections
```

If replay conflicts are substantive, assign resolution to the owning fix agent and require renewed review. Review the final range from `B`, not only the correction commit.

## PR Rules

- After a `MERGE` / `DEFAULT-BRANCH PR` decision, automatically push the exact final candidate and open a draft PR unless the user explicitly requested review-only/no external writes. Require explicit authorization for auto-merge or merge.
- Use the actual repository default branch; never assume it is named `master`.
- Refresh the target before opening or merging.
- Never change the reviewed branch in place when its base is stale; use a new refresh branch and record mapping.
- Re-run affected checks after refresh.
- Put acceptance IDs, test evidence, feature-flag state, dependencies, reviewed tip, and review artifact in the PR.
- Do not bypass CI, review requirements, or branch protection.
- Treat a PR as integrated only after its result is reachable from the refreshed target branch.

## Control and Integration Lineage

- Base each review control branch on the exact execution artifact commit for a standalone round. Under `run-feature-agent-loop`, use the later execution state commit resolved externally from its state ref. For a legacy handoff without an execution artifact, use the verified planning artifact commit or its later externally resolved state commit. Require docs-only ancestry and add a suffix rather than reusing an ambiguous collision.
- Base a fix round's execution control branch on the exact review artifact commit containing its fix prompt, or the later review state commit resolved externally from its state ref under `run-feature-agent-loop`. This creates the docs-only lineage `plan -> execution -> review -> execution`.
- When the declared integration branch is absent, initialize it from the first accepted integration-only candidate's exact launch base. Record the initialization commit, candidate tip, merge commit, and resulting integration tip.
- When it exists, require its recorded tip and provenance to agree with Git and require a clean integration worktree before trial merge. Retain and report an ambiguous collision instead of rewriting it.
- Unlock an `integration-tip` dependent only from the exact committed tip produced after its wave gate passes.

## Final Integration Delivery

When the milestone's accepted result is on the integration branch and must reach the default branch:

1. Refresh the default target and record its exact tip.
2. Review the complete `<default-tip>..<integration-tip>` delta and rerun aggregate and required E2E gates.
3. Follow repository delivery policy; prefer a protected PR. Do not direct-merge or push unless that mechanism is both permitted and explicitly authorized.
4. Record the integration source tip, target tip, delivery mechanism, PR URL when applicable, checks, required reviews, merge commit, and refreshed-target reachability.
5. Mark delivery complete only when the accepted commits are reachable from the refreshed default branch.

## Loop State

```text
READY_FOR_REVIEW
  -> DO_NOT_MERGE/BLOCKED
  -> FIX_PROMPT
  -> REFRESHED_FIX_BRANCH
  -> READY_FOR_REVIEW

READY_FOR_REVIEW
  -> MERGE/DEFAULT-BRANCH PR
  -> PR_OPEN
  -> PR_MERGED
  -> DEFAULT_BASE_REFRESHED

READY_FOR_REVIEW
  -> MERGE/INTEGRATION ONLY
  -> INTEGRATED
  -> WAVE_GATE_PASSED
```

Unlock a dependent only after its prerequisite is present in the declared base: merged default branch or verified integration tip.

## Final Gate

Approve delivery only when current milestone criteria are implemented, blocking findings are resolved, required tests and E2E evidence pass, dependencies are present in the target base, aggregate scope is explained, and rollout or rollback needs are satisfied. Ignore explicitly deferred criteria.
