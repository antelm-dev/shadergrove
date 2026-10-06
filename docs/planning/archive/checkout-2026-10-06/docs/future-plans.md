# Shadergrove future plans

Status: roadmap ideas, 2026-10-02. This document records priorities and candidate
milestones; it is not an executable feature plan or authorization to implement,
deploy, provision cloud resources, or publish a release.

Repository baseline: `develop` at `dfc6d7bc9e96c215a8047990c93ad01e15ac6127`.
Statuses were checked against planning documents, merged source and Git history.
Tests, production deployments and packaged desktop checks were not rerun for
this inventory. Implementation completion does not establish release readiness.

## Completed milestones

These planning branches are retired because their bounded milestone is implemented
in `develop`. Deferred work from each plan remains eligible for a separate milestone.
The original plan commits below identify the documents used for this inventory;
they are historical identifiers, not retained branch references.

| Retired planning branch            | Completed scope                                                                                            | Original plan commit | Implementation evidence              |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------ |
| `plans/inspector-surface`          | Contained floating inspector, docking, window controls and persistent state                                | `b1b181f`            | PR #6                                |
| `plans/desktop-sync`               | Milestones 1 and 2: account sign-in, uploads, pulls, keep-both conflicts and queued deletion               | `36495dd`            | PRs #18–21 and #24–26                |
| `plans/studio-visual-refresh`      | Self-hosted UI/icon fonts, neutral styling, density and overlay treatment; subsequent UI work extends this | `a514a26`            | PR #32 and preceding styling commits |
| `plans/public-explore-admin`       | Publication snapshots, public Explore, copy-to-library, reports and moderation                             | `95f0593`            | PR #34                               |
| `plans/custom-postprocess-effects` | Embedded single-pass custom effects, independent instances, controls, editing and persistence              | `1ff7ea6`            | PR #36                               |
| `plans/local-isf-plugins`          | Local package contract, bounded runner, installation UI and supported single-pass ISF filter import/export | `5a6b7e6`            | PRs #35 and #38                      |
| `plans/plugin-themes`              | Local theme packages, UI/Monaco selection, persistence and fallback                                        | `287aeaf`            | PR #41                               |

At the baseline, inspector, desktop sync and visual refresh are also in `master`.
Explore, custom effects, ISF plugins and plugin themes remain in `develop` only.
Neither a public plugin marketplace nor standalone effect publication is included
in these completed milestones.

## First action: consolidate the release

Before adding another large feature, bring the release documentation and validation
up to date with the merged behavior.

- Correct README claims that sync is upload-only, Explore is absent, plugins are
  only a prototype, and post-processing permits only one instance of each built-in
  effect. State supported ISF boundaries and feature/build flags accurately.
- Extend `docs/release-readiness.md` to cover custom effects, plugin installation,
  theme lifecycle, bidirectional sync and opt-in public publishing/moderation.
- Validate an exact release candidate with the required automated checks, real
  PostgreSQL, browser workflows and an installed desktop app, including offline
  restart and hostile-plugin isolation. Record every unexecuted check explicitly.
- Review promotion from `develop` to `master` as a separate release operation.

The Next.js website is already committed at the baseline. Its deployment and the
journey from the website into a working studio still need their own validation.

## Retained plans and recommended order

| Order           | Retained branch                     | Next usable milestone                                                                          | Reason                                                                           |
| --------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1               | `plans/shader-history`              | Durable source/settings/preset snapshots, named checkpoints and guarded restore                | Protect experimentation and recover earlier saved work                           |
| 2               | `plans/shadertoy-wallpaper-plugins` | Two official installable packages, Available discovery and complete wallpaper project delivery | Give the plugin system useful official integrations and improve export usability |
| 3               | `plans/community`                   | Opt-in creator profiles/galleries and public direct-remix discovery                            | Connect existing public works to creators and their derivatives                  |
| 4               | `plans/multi-editor-windows`        | Contained right/down editor splits with group identity and persisted geometry                  | Improve multipass and multi-document editing                                     |
| 5               | `plans/native-bottom-panel`         | A native Problems/Output satellite with live updates, diagnostic reveal and docking            | Improve desktop workspace flexibility                                            |
| Deployment gate | `plans/minio-hybrid-storage`        | External asset references, private object storage, durable cleanup and verified GCP deployment | Fulfil the existing first-GCP-deployment prerequisite                            |

If the first GCP launch is the next delivery target, advance hybrid storage before
public launch, as its retained plan requires. Otherwise, schedule it around hosting
needs while history and integrations proceed.

Refresh each retained plan before execution. Older prompts refer to `apps/web`,
separate API/desktop packages and delivery directly to `master`; the application
now lives under `apps/studio`. Record a current immutable launch SHA, reconcile
contracts with the latest plugin/theme changes, and update checks and integration
targets. Existing editor groups and native-window infrastructure are foundations,
not evidence that editor splits or the bottom-panel satellite are complete.

## Candidate future milestones

### F1 — Reusable effect library

Let an author save a custom effect independently, find it again, and copy it into
another shader. Begin with a private library and a standalone versioned effect
file; keep full effect definitions embedded in shaders so they survive offline
use, library changes and package removal.

Define provenance and license metadata before introducing public effect sharing.
Public discovery, multipass effects and auxiliary textures are later milestones.

Acceptance: create an effect, save it to the library, add it twice to another
shader, export/import it, and reopen the shader offline with independent values.

### F2 — Explore search and discovery

Add explicit tags and bounded search across title, description and public creator
identity. Start with deterministic Newest and Recently updated sorts. A Newest
sort should use publication time; the current listing orders by update time.

Only add capability filters for features represented by the actual project model
and supported renderer. Popularity ranking requires an agreed signal and abuse
rules, so it is outside the first milestone.

Acceptance: stable pagination for each sort/filter combination, no hidden work or
private identity leakage, and predictable results after publication updates.

### F3 — Favorites and collections

After creator/remix phase 1, add private account bookmarks, followed by private and
public collections with ordered items and explicit sharing. Define what happens
when an item is unpublished, deleted or moderated.

This extends the existing community backlog. Comments/replies, following and
in-app notifications follow in separate milestones, with moderation, event
deduplication and visibility rules defined before implementation. Challenges,
pedagogical features and editorial selections remain deferred.

Acceptance: two accounts can save independent bookmarks; an anonymous visitor can
read only an explicitly shared collection and its currently public items.

### F4 — Export fidelity and embeddable playback

After the official export-plugin milestone, define a supported playback contract
covering passes, feedback, textures, controls and post-processing. Close measured
fidelity gaps, then deliver a small embeddable player or a Three.js export using a
fixed runtime owned by Shadergrove.

Current Wallpaper export omits post-processing with a warning. Preserving effects
is additional work beyond migrating that exporter into a plugin. Export snapshots
must contain the selected draft and its values; executable templates remain owned
by the host.

Acceptance: representative exported projects render independently with their
documented controls and supported effects, with explicit compatibility reports.

### F5 — Parameter animation, then live inputs

Begin with a small timeline for numeric/color controls: keyframes, interpolation,
playback, scrubbing and portable saved animation. Specify how animated values
interact with manual edits, presets and exported playback.

Audio and MIDI bindings are subsequent milestones. Design stream ownership,
permission handling, mapping and cleanup before exposing real-time inputs through
plugins. Do not imply that current ISF support includes audio or arbitrary inputs.

Acceptance: a saved animation plays consistently after reload and export; seeking
reproduces parameter values without changing the shader source.

### F6 — First-use journey and production onboarding

Connect the website to a short create/import → edit → save → export/publish journey.
Use one original example with generated controls and one custom effect. Explain
offline desktop use, optional accounts and feature availability at the relevant
step. Explore remains conditional on the server's capability flag.

Include a documented, explicit MCP activation/pairing flow as a separate bounded
part of onboarding; current production activation requires app configuration.

Acceptance: a fresh browser user and a fresh offline desktop user can complete the
applicable journey without prior repository knowledge or losing their first draft.

## Planning rules for the next milestone

- Select one user outcome and write a dedicated implementation plan with scope,
  dependencies, ownership, acceptance criteria and executable validation.
- Treat the candidates above as proposals, not committed feature promises.
- Preserve existing project/bundle compatibility and offline usability.
- Separate source implementation, release validation and production deployment
  evidence. A build or unit-test result cannot substitute for an installed-app or
  external-tool check.
- Revisit priority after delivering a milestone using actual authoring workflows,
  reported failures and hosting requirements.
