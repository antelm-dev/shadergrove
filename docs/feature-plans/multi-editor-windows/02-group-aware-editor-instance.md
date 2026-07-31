# Task 02 — group-aware editor instances

## Mission

Make the editor shell, panel, and controls explicitly group/surface-aware while keeping the currently rendered default editor behavior unchanged. This creates an independently testable component seam for the later split host. Read the coordinator `README.md` before starting.

## Launch base and isolation

- Base policy: `latest-default`; prerequisite: none.
- Coordinator replaces `<exact-launch-base>` with the immutable refreshed `master` SHA.
- Branch: `codex/multi-editor-windows-02`.
- Sibling worktree: `<repo-parent>/shader-studio-multi-editor-02`.

```text
git worktree add <absolute-sibling-path> -b codex/multi-editor-windows-02 <exact-launch-base>
cd <absolute-sibling-path>
git status --short --branch
```

The initial status must be clean.

## Context and owned scope

Primary ownership is `apps/web/src/app/ui/editor/editor-shell.ts`, `editor-panel.ts`, `editor-window-controls.ts`, and their focused specs. `EditorTabs` already accepts `groupId`; `EditorGroups.activeDocumentId/openDocs/activate` are the group API. `ShaderStore.activeDoc()` is global and must not silently choose the document displayed by every editor instance.

## Required work

- Add required or default-compatible `EditorGroupId` and `SurfaceId` inputs through shell → panel → tabs/controls. The existing `<app-editor-shell>` must continue to mean the default group and surface until Task 03 changes the host.
- Derive the panel’s displayed `EditorDocument` by its group’s active document ID and current store documents. Route tab selection, cycle/close actions, diagnostics, explorer focus, commands, Monaco document binding, and window controls through that identity.
- Preserve independent Monaco view state for distinct component instances; consume existing `EditorGroupSession` transfers where applicable. Do not create a competing source-text model.
- Make geometry, activation, close, dock/float/maximize/minimize, z-index, and ARIA labels use the supplied surface rather than `layout.editorId`.
- Add component tests with two explicit group IDs proving independent tab lists/active documents and commands, plus regression coverage for the default input path.

## Out of scope and contracts

Do not render multiple shells, add split controls, alter persisted layout schemas, or implement Electron satellites. Do not change the unique-document ownership policy. This task must expose no new unfinished UI and remain safe to deploy alone.

## Verification and delivery

Acceptance: `AC-IDENTITY`.

```text
pnpm --filter @shader-studio/web test
pnpm --filter @shader-studio/web typecheck
pnpm format:check
```

Review the complete diff. Make 1–3 logical commits. Intended destination is a default-branch PR, but do not push or open it without explicit authorization. Report exact base/HEAD SHAs, commits, changed paths, test evidence for two instances and the default path, and risks.
