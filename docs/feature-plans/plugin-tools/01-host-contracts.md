# 01 — Plugin tool contracts and host seam

Read the supplied coordinator README. Mission: establish the versioned boundary needed by all four tools, with no incomplete official packages listed.

Launch: integration-only, integration-tip; exact base **<coordinator-recorded-sha>** after source/target reconciliation. No task prerequisites. Branch `codex/plugin-tools-01`; proposed clean worktree `E:/Adel/Documents/Orgs/shader-studio-plugin-tools-01`. Never use a moving ref as the launch base.

Primary ownership is the shared plugin boundary: `libs/shared/src/plugin/tools.ts` (new), `package.ts`, `apps/studio/src/app/plugins/plugin-host.ts`, `plugin-tools.ts` / `plugin-tools-outlet.ts` (new), and `tools/workspace/src/generate/official-plugins.ts`. Collocated contract/host tests are included. Coordinate necessary shared export/sandbox type changes; do not implement tool-specific panels.

Implement protocol 4 and exactly the README's analyzer, assetTool and projectTemplate schemas, validators, binary accounting and limits. Add backwards-compatible package parsing and deterministic generator support for declarative template payloads and tool Worker sources. Unknown schema/workflow IDs are refused.

Extend the existing fresh-Worker queue/timeout/cancellation path; avoid a second Worker host. Analyzer and asset operations return validated unapplied candidates. Data-only recipes need no Worker. Freeze the palette JSON, RGBA descriptors, findings, capability profiles and template shape before downstream launch.

Provide registered host adapters, active-contribution enumeration, a generic Installed-card outlet and operation-context/fingerprint/request guards. Host renders UI; package code cannot register Angular components or file/GPU/network hooks. Check before result display and before apply/download/assignment. Coalesce previews and preserve input buffers when transferring copies.

A coordinator owns central app providers/menu/New wiring, translations, release listing and aggregate generated outputs after your integration. Supply wiring snippets and adapter APIs. Registered contributions alone are offered; SSR/satellite/output windows remain inert. Add test adapters/fixtures proving the entire seam without publishing unfinished real tools.

Out of scope: recipe content, Doctor rules, image algorithms, palette UI, generic plugin refactoring, semantic tooling and backend migrations.

Verify AC-CONTRACT and AC-LIFECYCLE using README's shared tools/package tests, focused host/plugin-tools Angular tests, old importer/exporter regression cases, byte-length/typed-view boundary cases and a delayed stale-result fixture. Run IPC generation and relevant typechecks. Demonstrate timeout/termination using existing sandbox patterns; document which installed-desktop evidence remains for the coordinator.

Deliver 1–3 logical commits and exact head/launch SHA, paths, contract decisions and checks. Request acceptance of the frozen seam before 02–04 launch. No push/PR/merge; intended integration review destination is develop.
