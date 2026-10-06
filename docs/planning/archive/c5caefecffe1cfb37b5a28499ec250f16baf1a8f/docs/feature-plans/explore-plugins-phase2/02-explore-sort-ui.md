# Worker 02: Explore sort UI and complete browsing state

## Mission, base and isolation

Read this phase README and the full roadmap supplied with the prompt. Expose Recently updated and Recently published using the accepted API, extending Phase 1's browsing restoration consistently.

Prerequisites: Phase 1 and Phase 2 Task 01 accepted and merged to master. Delivery `default-branch-pr`, destination `origin/master`, base `latest-default`. Coordinator records `EXACT_LAUNCH_BASE=<refreshed full master SHA>` containing the accepted API. Do not start from an unmerged API branch or planning ref.

```text
git worktree add E:/Adel/Documents/Orgs/shader-studio-explore-plugins-p2-02 -b codex/explore-plugins-p2-02-ui <EXACT_LAUNCH_BASE>
cd E:/Adel/Documents/Orgs/shader-studio-explore-plugins-p2-02
git status --short --branch
```

## Ownership and context

Own `apps/studio/src/app/publications/explore-page.ts`, `publication-api.ts`, Phase 1 `explore-browse-state.ts`, detail return context in `publication-page.ts`, matching SSR transfer state only if needed, adjacent publication tests, `apps/studio-e2e/src/explore-navigation.spec.ts`, and required en/fr keys. Read the shared sort type, backend behavior and Phase 1 implementation; do not change API/cursor/migration contracts or shell/navigation.

## Required work

- Add an accessible labelled sort selector for shared `updated`/`published` values, phrased Recently updated / Recently published. Omit updated from the URL; preserve q. Normalize unknown client values to updated with replace navigation; changed user selections push one history entry.
- Send the selected sort through PublicationApi using the accepted shared type. Existing no-sort callers keep updated defaults. Do not infer or decode cursor contents in the UI.
- A user sort/query change starts from page one with a fresh cursor and scroll position; never append a response from a superseded query/sort. Update Phase 1 cache and transfer-state matching keys to normalized `(q,sort)`, keeping bounds, expiry and browser-only public caching.
- Both browser Back and detail's Explore link restore full q/sort/results/cursor/scroll state. Fresh direct details retain Phase 1's fallback. Revisit two sorts of the same search without mixing their results.
- Direct URLs, reload, SSR first-page fetches and hydration use the same sort. Preserve static thumbnails, opt-in preview, empty/error/unavailable states and retry behavior. Keep public Explore web-only and gated; no desktop HttpClient.
- Search field wording should reflect broader title/description/author matching. No filters, ranking, tags, provider integration or publication metadata edits.

Contracts/acceptance: **AC-P2-URL**, **AC-P2-CACHE**, **AC-P2-REGRESSION**. Do not duplicate backend ownership; a contract defect returns to Task 01/coordinator.

## Checks and delivery

Run Task 02 checks in README. Unit/browser tests cover direct q/sort URLs, malformed client sort, same-route history, both return paths after page two, cache separation, query/sort response races and error retry. Browser fixtures may mock public endpoints for controlled data; those do not prove SQL or migrations. Inspect built SSR HTML/hydration for published and updated URLs. Preserve an unsaved shader throughout browsing.

Produce 1–3 logical commits and a complete diff review. Report exact launch/commit SHAs, acceptance IDs, commands and exit results, skipped/manual-unverified checks and risks. Complete independent deployment requires the merged API; no new flag or persisted client state. Roll back UI before the API if deployment is split. No remote PR actions without later authorization.
