# Worker 02: Explore URL and browsing restoration

## Mission and launch

Read the coordinator README supplied with this prompt. Make Explore search shareable and navigable, and preserve loaded results and host scroll position across a publication visit.

Delivery: `default-branch-pr` to `origin/master`; base policy: `latest-default`; prerequisites: none. Coordinator supplies `EXACT_LAUNCH_BASE=<full fetched origin/master SHA>`; record it before editing. Do not use the planning branch as the runtime base. Use branch `codex/explore-plugins-02-explore-state` and sibling worktree `E:/Adel/Documents/Orgs/shader-studio-explore-plugins-02`; coordinator handles collisions.

```text
git worktree add E:/Adel/Documents/Orgs/shader-studio-explore-plugins-02 -b codex/explore-plugins-02-explore-state <EXACT_LAUNCH_BASE>
cd E:/Adel/Documents/Orgs/shader-studio-explore-plugins-02
git status --short --branch
```

## Context and ownership

Own `apps/studio/src/app/publications/explore-page.ts`, `publication-page.ts`, new `explore-browse-state.ts`, adjacent Explore/cache tests, and `page.ts` only where matching-query TransferState requires it. Own new `apps/studio-e2e/src/explore-navigation.spec.ts`. Read PublicationApi, ExploreAccess, RoutingCoordinator, shared publication limits and the current backend query/cursor; leave these APIs unchanged. Do not edit plugin tests or shared E2E server/fixture configuration.

## Required behavior

- Query param `q` is search source of truth. Normalize by trimming and applying the existing search length limit; omit an empty q. Subscribe to query changes even while the route component is reused. Changed submitted searches push history; normalization replaces history; do not navigate per keystroke.
- Continue calling `PublicationApi.list(search, cursor)` with existing title-only search and updated-order semantics. Add no sort UI, query contract or backend cursor changes.
- Use a small root service holding public browser-memory snapshots keyed by normalized q and the existing sort policy. Store completed accumulated results, cursor and host scroll; retain at most three queries, expiring five minutes after the completed fetch. No localStorage or cached loading/errors. Expired/missing snapshots load normally.
- Opening a detail and returning via browser Back or its Explore link restores q, all loaded pages, cursor and scroll after cards render. A direct detail visit has no previous context and falls back to `/explore`. Keep return context local to this browser session; publication URLs remain shareable.
- Capture the actual page host's scrollTop; window/router built-in restoration cannot restore this container. Prevent delayed responses or scroll callbacks from landing on a different query, including rapid Back/Forward and page-two requests.
- Honor q in SSR first-page requests and hydration. Transfer only the response matching the rendered q, not unrelated service snapshots. A root cache must never leak state between SSR requests. Preserve unavailable/error/retry/empty states, static thumbnails, opt-in previews, access gates and draft preservation.

Contracts/acceptance: **AC-EXPLORE-URL**, **AC-EXPLORE-RESTORE**, **AC-EXPLORE-ROBUST**, **AC-WORKSPACE**. Deferred: broader search, sorting/cursors, filters, shell navigation, desktop Explore and plugin management changes.

## Verification and delivery

Run Task 02 checks from README. Add meaningful tests for route reuse/history, cache bounds/expiry, separate queries, stale responses, and matching SSR transfer state. E2E should mock public capability/list/detail endpoints with at least two pages and enough cards to scroll, then exercise both return paths, direct links, reload and Back/Forward. Preserve a modified editor draft throughout. Serialize Playwright with worker 01. Manually inspect initial SSR q HTML/hydration; distinguish that from mocked browser evidence.

Produce 1–3 logical commits, review the entire diff, and report exact commits/base, acceptance IDs, commands/exit results and risks. Retain the existing Explore feature gate; no migration/new flag. Safe independent deployment and revert. No remote PR actions without later authorization.
