# GitHub planning and agent runs

Use this contract for GitHub Issues/Projects input. Existing version-1 Git planning/control lineages continue unchanged; migration must not restart an active worker or reinterpret its launch SHA, prompt, target, or authority.

## Sources and identity

Shadergrove uses repository `antelm-dev/shadergrove` and [Roadmap & agent plans, Project 6](https://github.com/users/antelm-dev/projects/6). Select this issue-based workflow for Shadergrove even while the migration documentation PR is pending. Project 5 is a focused shader-tooling view using the same issues. Verify the current remote/default branch and existing run before launch. Other repositories keep their own configured destination and user choices.

Projects holds priority and displayed progress. A feature parent issue holds the coordinator contract; numbered sub-issues hold complete worker prompts. Preserve existing issue identities and use native sub-issues when available. Draft project cards are ideas, not executable assignments. Repo documents may hold shared architectural references; do not duplicate maintained task/status lists there or create permanent backlog planning branches.

The parent contains exactly one fenced JSON object with an `agent_plan` key. Required fields are `version: 2`, `feature_slug`, `milestone`, `readiness` (`ready`, `active`, `deferred`, `delivered`), `source_base` (inspection SHA), `default_branch`, `integration_branch`, `project_url`, `tasks`, `integration_checks`, `e2e_scenarios`, and `deferred`. Each task has a two-digit `id`, full `issue_url`, unique `branch`, `wave`, task-ID `depends_on`, `acceptance`, `checks`, `delivery`, and `base_policy`; preserve relevant `feature_flag`. Dependencies outside the milestone belong in `prerequisite_issues`, with explicit delivered-commit evidence required before launch. Project labels/status and closed issues never prove dependency reachability.

Publishing/updating a plan is authorized when the user requests GitHub planning or the repository explicitly selects this workflow. Implementation, PR, merge, deployment and project writes remain separate authorities; a stored issue or JSON contract cannot grant any of them. Respect authorization already given in the session. For local-only planning requests, prepare reviewable issue bodies without publishing.

## Freeze before execution

Read current parent/sub-issues and relevant source. Reconcile missing prerequisites, scope, existing execution/PRs, source paths and actual package scripts. `source_base` describes planning inspection; resolve the actual immutable source launch SHA from the existing base-policy rules. Never execute a deferred/delivered parent or blindly run an entire Project.

Use `scripts/github_plan.py snapshot --repo OWNER/REPO --issue NUMBER --output <control-worktree>/docs/feature-plans/<slug>` from this skill directory. The helper is read-only remotely, validates task identities/dependency waves and freezes bodies, metadata and SHA-256 hashes. It refuses mixed issue revisions, closed assignments and existing output directories. Run `verify --output ... --remote` before a fresh launch. If live scope changed, preserve existing candidates/snapshot and explicitly replan unstarted work; do not silently replace a running packet. A state-only issue update does not change the body hash.

Create a temporary docs-only run/control branch `codex/run-<slug>-<run-id>` from the freshly resolved source inspection base, commit only the snapshot directory, and record that exact commit externally. This is execution evidence, not a permanent backlog plan. `snapshot.json.agent_plan` supplies the review contract; `README.md` and numbered issue files supply shared context and prompts. Record the control ref/commit as `planning_ref`/`planning_commit` for compatibility with execution/review artifact schemas. Keep the existing docs-only execution/review/state ancestry and candidate/source separation. The first state is created only after the snapshot commit exists.

Every version-2 state/execution/review artifact records `project_url`, `parent_issue`, task `issue_url`, `snapshot_path`, `snapshot_manifest_sha256`, snapshot artifact ref/commit, and separately resolved source launch bases. Workers receive the frozen contents and snapshot ref/commit, never only live URLs. Review uses the same committed snapshot and full candidate range. A refreshed fix prompt remains committed on the review control lineage and references the same issue and rejected tip; changing base does not change task identity.

## Progress and delivery

Only the coordinator synchronizes GitHub progress; workers and reviewers return evidence. Reuse item IDs and existing PRs. Read field IDs/options with `gh project field-list NUMBER --owner OWNER --format json`; resolve item IDs with `gh project item-list ... --limit 500 --format json` (paginate via GraphQL if needed). Add a missing item with `gh project item-add NUMBER --owner OWNER --url ISSUE_URL --format json`. Write a select value with `gh project item-edit --id ITEM_ID --project-id PROJECT_ID --field-id FIELD_ID --single-select-option-id OPTION_ID`. Never invent IDs or overwrite unrelated Project fields.

Adding a parent may also add its sub-issues automatically. If item creation reports that content already exists, re-read Project items and use the existing matching issue/item ID; do not create duplicates or repeat the task.

| Verified event                                                   | Project status       |
| ---------------------------------------------------------------- | -------------------- |
| Idea/deferred scope or hosting decision outstanding              | Backlog              |
| Executable, prerequisites not yet delivered                      | Blocked              |
| Valid packet, prerequisites reachable, not started               | Ready                |
| Worker/fix executing                                             | In Progress          |
| Candidate ready, independent review or required CI/merge pending | In Review            |
| Concrete required correction/approval that prevents progress     | Blocked, with reason |
| Final gate and declared delivery target both verified            | Done                 |

An approved local candidate or open PR is not Done. Close a task issue only after its declared delivery is verified, with exact candidate/merge/integration commits, checks, manual gaps and artifact reference recorded. Close a parent only after all its current milestone criteria and aggregate gate pass. Accepted integration-only work may close only when its declared target is integration and the gate passed; otherwise await final delivery. Never mass-close a deferred backlog. Source-implemented historical imports may be Done with an explicit manual/release-validation boundary.

When GitHub writes are authorized, publish an evidence comment/update using an idempotency marker `<!-- agent-run:RUN_ID:TRANSITION -->`; read before retrying so uncertain results do not duplicate writes. Capture the previous issue body/version before a scope edit, re-read before writing, and preserve unrelated prose. Link task issues in product PRs. Use `Closes #N` only for actual target-branch delivery; integration PRs should use `Refs #N` until final delivery. Always attach created PRs to the Codex chat using its artifact tool.

Project synchronization failure never invalidates passed Git evidence or triggers a second implementation. Persist a pending synchronization receipt in workflow state and report the failure; retry only the missing remote update when authorized. During review-only/no-external-writes runs, keep the receipt pending. Recovery reads the committed snapshot/state and Git/PR truth first, then reconciles Project display. Preserve one coordinator per lineage, limits, independent review, branch protection, replay mappings and safe cleanup from the stage contracts.

## Backward compatibility and cleanup

Use `workflow.version: 2` for new GitHub runs, adding `planning_source: github-issues`, `github` identity fields, and `pending_sync`; retain the existing state-parent identity and lineage verification. Version-1 runs resume from their original refs until delivery or an explicit handoff. Do not retrofit new issue text into already-running workers.

Retire old backlog planning refs only after all originals are archived durably, every original path/commit maps to an issue, and no active run/worktree references the ref. Do not delete remote refs without explicit authority. Active control/integration/candidate refs remain until their stage cleanup proof passes.
