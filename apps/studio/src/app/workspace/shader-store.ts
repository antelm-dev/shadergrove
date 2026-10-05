import { Injectable, inject } from '@angular/core';

import {
  type ImportMode,
  type ParamValue,
  type RenderSettings,
  type TextureChannelSettingsPatch,
} from '@shadergrove/shared/model';
import {
  type ChannelBinding,
  type ChannelIndex,
  type PassResolution,
  type RenderPass,
} from '@shadergrove/shared/project';
import type { CompileDiagnostic } from '@shadergrove/shared/diagnostic';
import { CompilationService } from './compilation.service';
import { PersistenceService } from './persistence.service';
import { PresetService } from './preset.service';
import { TextureService } from './texture.service';
import { RecoveryFacade } from './lifecycle/recovery-facade';
import { SelectionLifecycle } from './lifecycle/selection-lifecycle';
import { reportWorkspaceError } from './lifecycle/report';
import { DocumentState } from './state/document-state';
import {
  ProjectMutations,
  type DraftTextEdit,
  type PatchFailure,
  type SetParamsOutcome,
} from './state/project-mutations';
import { parseControls } from './state/controls-schema';
import { ShaderApi } from '../api/shader-api';
import { OutputLog } from '../ui/bottom-panel/output-log';

/**
 * The workspace, as the rest of the application sees it.
 *
 * Everything below is one of three things: a persistence workflow the store
 * still owns — saving, importing, presets, textures — or an alias onto the
 * signal that `DocumentState` owns, or a delegation to the collaborator that
 * owns the behaviour:
 *
 *  - `DocumentState`      — the four layers of document data (record, saved,
 *                           draft, params) and every projection off them.
 *  - `ProjectMutations`   — every edit to the open document, including the
 *                           atomic MCP patch path.
 *  - `CompilationService` — the draft revision and the compile waiters.
 *  - `SelectionLifecycle` — which shader is open: startup, hydration, reading a
 *                           record and adopting it, and clearing it again.
 *  - `RecoveryFacade`     — the browser's own copies: the unsaved draft, and the
 *                           pre-upgrade local project on its way to the server.
 *
 * The aliases are aliases and not copies: `store.record` *is*
 * `DocumentState.record`, so there is exactly one instance of every signal and
 * no possibility of the facade and the owner disagreeing. Consumers keep the
 * names they have always used.
 */

export type { ShaderDraft, DocumentKind, EditorDocument } from './state/document-state';
export type { DraftTextEdit, SetParamsOutcome } from './state/project-mutations';

/** A finished compile, tied to the revision it was compiled from. */
export interface CompileOutcome {
  revision: number;
  diagnostics: readonly CompileDiagnostic[];
}

export type ApplyPatchResult =
  | { ok: true; revision: number; diagnostics: readonly CompileDiagnostic[] }
  | PatchFailure;

@Injectable({ providedIn: 'root' })
export class ShaderStore {
  private readonly api = inject(ShaderApi);
  private readonly textureService = inject(TextureService);
  private readonly presetService = inject(PresetService);
  private readonly compilation = inject(CompilationService);
  private readonly persistence = inject(PersistenceService);
  private readonly outputLog = inject(OutputLog);
  private readonly documentState = inject(DocumentState);
  private readonly mutations = inject(ProjectMutations);

  /**
   * Injected rather than merely delegated to: both are self-starting. Reaching
   * for `SelectionLifecycle` is what reads the SSR snapshot back out of the
   * transfer state, and constructing it is what installs `RecoveryFacade`'s
   * draft-mirroring effect — the same two things this constructor used to do.
   */
  private readonly selection = inject(SelectionLifecycle);
  private readonly recovery = inject(RecoveryFacade);

  // --- Document state (owned by `DocumentState`) ----------------------------

  readonly shaders = this.documentState.shaders;
  readonly record = this.documentState.record;
  readonly draft = this.documentState.draft;
  readonly params = this.documentState.params;

  readonly loading = this.documentState.loading;
  readonly saving = this.documentState.saving;
  readonly activePresetId = this.documentState.activePresetId;

  /** The document the editor is showing. One of `documents()`. */
  readonly activeDocId = this.documentState.activeDocId;

  /** Compile + config diagnostics for the current draft. */
  readonly diagnostics = this.documentState.diagnostics;

  /** Passes that are currently being recompiled, so their tabs can say so. */
  readonly compiling = this.documentState.compiling;

  /** Last message worth showing the user (error or confirmation). */
  readonly notice = this.documentState.notice;
  readonly staleRecovery = this.documentState.staleRecovery;

  readonly selectedId = this.documentState.selectedId;
  readonly presets = this.documentState.presets;
  readonly channels = this.documentState.channels;

  readonly project = this.documentState.project;
  readonly fragment = this.documentState.fragment;
  readonly vertex = this.documentState.vertex;
  readonly passes = this.documentState.passes;
  readonly buffers = this.documentState.buffers;
  readonly canAddBuffer = this.documentState.canAddBuffer;
  readonly renderOrder = this.documentState.renderOrder;
  readonly projectErrors = this.documentState.projectErrors;

  /** Every tab the editor can show, in the order it shows them. */
  readonly documents = this.documentState.documents;
  readonly activeDoc = this.documentState.activeDoc;
  readonly controls = this.documentState.controls;
  readonly configValid = this.documentState.configValid;
  readonly dirty = this.documentState.dirty;
  readonly allDiagnostics = this.documentState.allDiagnostics;
  readonly hasErrors = this.documentState.hasErrors;

  /** Errors belonging to one document — what its tab shows a badge for. */
  diagnosticsFor(docId: string): CompileDiagnostic[] {
    return this.documentState.diagnosticsFor(docId);
  }

  errorCountFor(docId: string): number {
    return this.documentState.errorCountFor(docId);
  }

  // --- Revisions (owned by `CompilationService`) ----------------------------

  /**
   * Bumped once by every `DocumentState.patchDraft` call — the single choke
   * point behind every project/controls/render mutation. This is what
   * `apply_shader_patch` checks a `baseRevision` against, and what
   * `waitForCompile` correlates a finished compile back to a specific edit.
   * Aliased here so external readers (`shader-canvas`, `McpBridge`) keep reading
   * it straight off the store.
   */
  readonly draftRevision = this.compilation.draftRevision;

  /** The revision `recordCompileResult` most recently landed. -1 until the first compile. */
  readonly compiledRevision = this.compilation.compiledRevision;

  /** Bumped to ask `shader-canvas` to flush its debounce timer immediately instead of waiting ~400ms. */
  readonly immediateCompileRequest = this.compilation.immediateCompileRequest;

  /**
   * Force a recompile now, rather than when the debounce elapses.
   *
   * The renderer recompiles a pass whose *composed source* changed, which means
   * asking for a recompile of a source nobody touched would be a no-op. So the
   * request is a signal the canvas watches, not a source edit: it says "compile,
   * even though nothing changed", which is what the user means by Ctrl+Enter
   * after the driver has been sulking or a texture has finished loading.
   */
  readonly recompileRequest = this.compilation.recompileRequest;

  recompile(): void {
    this.compilation.recompile();
  }

  // --- Loading (owned by `SelectionLifecycle`) ------------------------------

  /**
   * Load the collection and open the first shader, then publish the result for
   * the client to pick up. Runs during SSR, against the same Express process's
   * own `/api`.
   */
  initialize(routeShaderId?: string | null): Promise<void> {
    return this.selection.initialize(routeShaderId);
  }

  /** Called once the browser has taken over the server's snapshot. */
  initializeClient(routeShaderId?: string | null): Promise<void> {
    return this.selection.initializeClient(routeShaderId);
  }

  refreshList(): Promise<boolean> {
    return this.selection.refreshList();
  }

  select(id: string): Promise<void> {
    return this.selection.select(id);
  }

  reloadLibrary(): Promise<void> {
    return this.selection.reloadLibrary();
  }

  closeLibrary(): void {
    this.selection.closeLibrary();
  }

  // --- Recovery (owned by `RecoveryFacade`) ---------------------------------

  resolveRecovery(restore: boolean): void {
    this.recovery.resolve(restore);
  }

  discardCurrentDraft(): void {
    this.selection.discardDraft();
  }

  /**
   * Write the dirty draft out now rather than on the next debounce tick — what
   * the page does on its way out, when there may be no next tick.
   */
  flushRecovery(): void {
    this.recovery.flush();
  }

  // --- Editing (owned by `ProjectMutations`) --------------------------------

  /** The Image pass's source — the shader's `fragment`, by any other name. */
  setFragment(fragment: string): void {
    this.mutations.setFragment(fragment);
  }

  setVertex(vertex: string): void {
    this.mutations.setVertex(vertex);
  }

  setDocSource(id: string, source: string): void {
    this.mutations.setDocSource(id, source);
  }

  selectDoc(id: string): void {
    this.documentState.selectDocument(id);
  }

  /** Next or previous tab, wrapping. What Ctrl+PageDown does everywhere else. */
  cycleDoc(step: 1 | -1): void {
    this.documentState.cycleDocument(step);
  }

  addBufferPass(): void {
    this.mutations.addBufferPass();
  }

  duplicateBufferPass(id: string): void {
    this.mutations.duplicateBufferPass(id);
  }

  removeBufferPass(id: string): void {
    this.mutations.removeBufferPass(id);
  }

  renamePassById(id: string, name: string): void {
    this.mutations.renamePassById(id, name);
  }

  setPassEnabledById(id: string, enabled: boolean): void {
    this.mutations.setPassEnabledById(id, enabled);
  }

  movePassTo(id: string, toIndex: number): void {
    this.mutations.movePassTo(id, toIndex);
  }

  setPassResolutionById(id: string, patch: Partial<PassResolution>): void {
    this.mutations.setPassResolutionById(id, patch);
  }

  setPassSamplingById(
    id: string,
    patch: { filter?: RenderPass['filter']; wrap?: RenderPass['wrap'] },
  ): void {
    this.mutations.setPassSamplingById(id, patch);
  }

  setChannel(id: string, channel: ChannelIndex, binding: ChannelBinding): void {
    this.mutations.setChannel(id, channel, binding);
  }

  addSourceFile(name?: string): void {
    this.mutations.addSourceFile(name);
  }

  duplicateSourceFile(id: string): void {
    this.mutations.duplicateSourceFile(id);
  }

  removeSourceFile(id: string): void {
    this.mutations.removeSourceFile(id);
  }

  renameSourceFile(id: string, name: string): void {
    this.mutations.renameSourceFile(id, name);
  }

  moveSourceFile(id: string, toIndex: number): void {
    this.mutations.moveSourceFile(id, toIndex);
  }

  setControlsText(controlsText: string): void {
    this.mutations.setControlsText(controlsText);
  }

  setRender(render: RenderSettings): void {
    this.mutations.setRender(render);
  }

  setParam(key: string, value: ParamValue): void {
    this.mutations.setParam(key, value);
  }

  resetParams(): void {
    this.mutations.resetParams();
  }

  // --- Diagnostics --------------------------------------------------------

  /** Replace the compile diagnostics, leaving config diagnostics in place. */
  setCompileDiagnostics(diagnostics: readonly CompileDiagnostic[]): void {
    this.documentState.setCompileDiagnostics(diagnostics);
  }

  /** Replace the custom post-processing effects' diagnostics; the renderer owns this list. */
  setEffectDiagnostics(diagnostics: readonly CompileDiagnostic[]): void {
    this.documentState.effectDiagnostics.set(diagnostics);
  }

  // --- Compile completion & revisions --------------------------------------

  /**
   * Called by `shader-canvas` once a compile for `revision` has actually
   * landed on the GPU — real completion, not a fixed wait. Resolves every
   * `waitForCompile` call whose revision is now satisfied: a waiter for an
   * older revision is satisfied by a newer compile too, since revisions are
   * cumulative and a later one already reflects everything an earlier one
   * would have.
   */
  recordCompileResult(revision: number, diagnostics: readonly CompileDiagnostic[]): void {
    this.documentState.setCompileDiagnostics(diagnostics);
    this.compilation.recordCompileResult(revision, this.allDiagnostics());
  }

  /** Resolves once a compile at or after `revision` has landed, or rejects after `timeoutMs`. */
  waitForCompile(revision: number, timeoutMs = 10_000): Promise<CompileOutcome> {
    return this.compilation.waitForCompile(revision, timeoutMs);
  }

  /**
   * Forces a compile now instead of waiting for the ~400ms debounce, and
   * resolves once it has actually happened. `force` recompiles every pass even
   * if its composed source is unchanged — Ctrl+Enter's contract; a plain edit
   * does not need it, since the engine's own diffing already detects the
   * change and recompiles exactly the affected passes.
   */
  async compileNow(force = false): Promise<CompileOutcome> {
    if (!this.project()) throw new Error('No shader is open.');

    const revision = this.draftRevision();
    if (force) this.recompile();
    this.immediateCompileRequest.update((n) => n + 1);
    return this.waitForCompile(revision);
  }

  // --- Patches (MCP) --------------------------------------------------------

  /**
   * Apply a batch of text edits to one or more documents atomically: either
   * every edit lands in a single draft mutation (one revision bump, one
   * compile), or none of them do. Used by `apply_shader_patch` — never called
   * from the UI, which edits one document at a time through `setDocSource`.
   *
   * `ProjectMutations` owns the all-or-nothing write; what is left here is the
   * decision to block on the compile it caused, and the empty batch that caused
   * none — which reports the diagnostics already on screen rather than waiting
   * for a compile nothing asked for.
   */
  async applyPatch(
    baseRevision: number,
    edits: readonly DraftTextEdit[],
  ): Promise<ApplyPatchResult> {
    const applied = this.mutations.applyTextEdits(baseRevision, edits);
    if (applied.status === 'failed') return applied.failure;
    if (applied.status === 'noop') {
      return { ok: true, revision: applied.revision, diagnostics: this.allDiagnostics() };
    }

    const outcome = await this.compileNow();
    return { ok: true, revision: outcome.revision, diagnostics: outcome.diagnostics };
  }

  /**
   * Validate and apply a batch of live parameter values in one call. Each
   * value is checked against the control that owns it via the same
   * `validateParamValue` the config editor's presets use — an unknown key or a
   * value of the wrong type is reported per-key rather than failing the whole
   * request.
   */
  setParamsValidated(values: Record<string, unknown>): SetParamsOutcome {
    return this.mutations.setParamsValidated(values);
  }

  // --- Persistence --------------------------------------------------------

  async save(): Promise<boolean> {
    const record = this.record();
    const draft = this.draft();
    if (!record || !draft || this.saving()) return false;

    const controls = parseControls(draft.controlsText);
    if (!controls) {
      this.documentState.notify('Fix the configuration schema before saving', true);
      return false;
    }

    this.saving.set(true);
    try {
      // Keep the live params and the open preset across a save: the user was
      // editing the source, not resetting the knobs.
      const presetId = this.activePresetId();
      const result = await this.persistence.save(
        record.id,
        draft,
        controls,
        this.params(),
        record.revision,
      );

      this.documentState.commitSaved(result.record, result.draft, result.params, presetId);

      await this.refreshList();
      this.documentState.notify(`Saved “${result.record.name}”`, false);
      // A legacy shared example saves under a new personal id. Its old draft
      // is now saved too; leaving it behind could offer it for another fork.
      if (record.id !== result.record.id) this.recovery.forget(record.id);
      this.recovery.forget(result.record.id);
      void this.capturePreview(result.record.id);
      return true;
    } catch (error) {
      this.report(error);
      return false;
    } finally {
      this.saving.set(false);
    }
  }

  /**
   * Photographs the shader that was just saved, so the library can show it
   * without opening it.
   *
   * Deliberately *not* awaited by `save`. The document is safely on disk the
   * moment the API answers, and reading a frame back off the GPU and encoding
   * it takes long enough (much longer on a software renderer) that waiting on
   * it would keep `saving` true — swallowing the next Ctrl+S, which the guard
   * at the top of `save` drops while one is in flight.
   *
   * Best-effort for the same reason: a preview is a convenience, and failing to
   * take one must never turn a successful save into a failed one. On any
   * problem the shader keeps whatever preview it had, and the next save tries
   * again. With no renderer — SSR, a test — there is simply nothing to capture.
   */
  private async capturePreview(id: string): Promise<void> {
    try {
      const thumbnail = await this.persistence.capturePreview(id);
      if (thumbnail === null) return;

      // Patch the capture into what is already on screen rather than adopting
      // the server's whole record: a newer save may have landed in the
      // meantime, and its source is the one the user is looking at.
      this.record.update((current) => (current?.id === id ? { ...current, thumbnail } : current));
      this.shaders.update((shaders) =>
        shaders.map((shader) => (shader.id === id ? { ...shader, thumbnail } : shader)),
      );
    } catch (error) {
      console.warn(`[store] could not capture a preview of "${id}"`, error);
      this.outputLog.warning(
        'workspace',
        `Could not capture a preview of "${id}": ${String(error)}`,
      );
    }
  }

  /** Shaders already photographed without a save this session, so a failure is not retried in a loop. */
  private readonly previewAttempted = new Set<string>();

  /**
   * Gives a shader that has never had a preview one, from what is on screen.
   *
   * The seeded examples, and anything imported, arrive without a preview and
   * would show a placeholder in the library until their first save — which for
   * a shader you only came to look at is never. Only for the open shader, as
   * saved and compiling: an unsaved draft or an error frame is not what the
   * shader in the library looks like. Once per shader per session.
   */
  captureMissingPreview(id: string): void {
    const record = this.record();
    if (record?.id !== id || record.thumbnail) return;
    if (this.dirty() || this.hasErrors() || this.previewAttempted.has(id)) return;

    this.previewAttempted.add(id);
    void this.capturePreview(id);
  }

  revert(): void {
    this.discardCurrentDraft();
  }

  // --- Collection actions -------------------------------------------------

  async create(name: string): Promise<void> {
    try {
      const created = await this.persistence.create(name);
      await this.refreshList();
      this.selection.adoptCreated(created);
      this.documentState.notify(`Created “${created.name}”`, false);
    } catch (error) {
      this.report(error);
    }
  }

  async duplicate(id: string, name?: string): Promise<void> {
    try {
      const copy = await this.persistence.duplicate(id, name);
      await this.refreshList();
      this.selection.adoptCreated(copy);
      this.documentState.notify(`Duplicated as “${copy.name}”`, false);
    } catch (error) {
      this.report(error);
    }
  }

  async rename(id: string, name: string): Promise<void> {
    try {
      const updated = await this.persistence.rename(id, name);
      await this.refreshList();
      if (this.selectedId() === id) {
        this.record.update((record) => (record ? { ...record, name: updated.name } : record));
      }
      this.documentState.notify(`Renamed to “${updated.name}”`, false);
    } catch (error) {
      this.report(error);
    }
  }

  async remove(id: string, removeRecord?: () => Promise<boolean>): Promise<void> {
    try {
      if (!(await this.persistence.remove(id, removeRecord))) return;
      await this.refreshList();

      if (this.selectedId() === id) {
        this.selection.clearCurrent();
        await this.selection.selectFallback();
      }
      this.documentState.notify('Shader deleted', false);
    } catch (error) {
      this.report(error);
    }
  }

  // --- Presets ------------------------------------------------------------

  /**
   * Capture the live params under a name. `withRender` also stores the render
   * settings currently in the draft, which is what makes a preset able to bring
   * its own bloom back with it.
   */
  async savePreset(name: string, withRender = false): Promise<void> {
    const record = this.record();
    const draft = this.draft();
    if (!record || !draft) return;

    try {
      const { preset, presets } = await this.presetService.save(
        record.id,
        name,
        this.params(),
        withRender ? draft.render : undefined,
        record.presets,
      );
      this.record.update((current) => (current ? { ...current, presets } : current));
      this.activePresetId.set(preset.id);
      await this.refreshList();
      this.documentState.notify(`Saved preset “${preset.name}”`, false);
    } catch (error) {
      this.report(error);
    }
  }

  /**
   * Apply a preset to the live params. Values are projected onto the *current*
   * schema, so a preset stored against an older set of controls still applies
   * cleanly — anything it does not mention falls back to that control's default.
   *
   * A preset that captured render settings also writes them into the draft, and
   * so can leave the document dirty: bloom is part of the saved shader, not a
   * live knob, and pretending otherwise would lose the change on the next load.
   */
  applyPreset(presetId: string): void {
    const plan = this.presetService.planApply(this.presets(), this.controls(), presetId);
    if (!plan) return;

    this.documentState.setParams(plan.params);
    if (plan.render) this.setRender(plan.render);
    this.activePresetId.set(plan.presetId);
  }

  async deletePreset(presetId: string): Promise<void> {
    const record = this.record();
    if (!record) return;

    try {
      const presets = await this.presetService.delete(record.id, presetId, record.presets);
      this.record.update((current) => (current ? { ...current, presets } : current));
      if (this.activePresetId() === presetId) this.activePresetId.set(null);
      await this.refreshList();
      this.documentState.notify('Preset deleted', false);
    } catch (error) {
      this.report(error);
    }
  }

  // --- Textures -------------------------------------------------------------

  async setTextureImage(channel: 0 | 1 | 2 | 3, file: File): Promise<void> {
    const record = this.record();
    if (!record) return;

    try {
      const result = await this.textureService.setImage(record.id, channel, file);
      if (!result.ok) {
        this.documentState.notify(result.message, true);
        return;
      }
      this.record.set(result.record);
      await this.refreshList();
      this.documentState.notify(result.notice, false);
    } catch (error) {
      this.report(error);
    }
  }

  async clearTextureImage(channel: 0 | 1 | 2 | 3): Promise<void> {
    const record = this.record();
    if (!record) return;

    try {
      const result = await this.textureService.clearImage(record.id, channel);
      this.record.set(result.record);
      await this.refreshList();
      this.documentState.notify(result.notice, false);
    } catch (error) {
      this.report(error);
    }
  }

  async setChannelSettings(
    channel: 0 | 1 | 2 | 3,
    patch: TextureChannelSettingsPatch,
  ): Promise<void> {
    const record = this.record();
    if (!record) return;

    try {
      const updated = await this.textureService.setChannelSettings(record.id, channel, patch);
      this.record.set(updated);
    } catch (error) {
      this.report(error);
    }
  }

  // --- Import / export ----------------------------------------------------

  async exportShader(id: string): Promise<unknown> {
    return this.api.exportShader(id);
  }

  async exportAll(): Promise<unknown> {
    return this.api.exportAll();
  }

  async importBundle(bundle: unknown, mode: ImportMode = 'rename'): Promise<void> {
    try {
      const result = await this.api.importBundle(bundle, mode);
      await this.refreshList();

      const first = result.imported[0];
      if (first) await this.forceSelect(first.id);

      const replaced = result.imported.filter((entry) => entry.replaced).length;
      this.documentState.notify(
        `Imported ${result.imported.length} shader${result.imported.length === 1 ? '' : 's'}` +
          (replaced ? ` (${replaced} replaced)` : ''),
        false,
      );
    } catch (error) {
      this.report(error);
    }
  }

  /**
   * Imports one shader a project-importer plugin produced, already resolved
   * and validated as a bundle by the host: in one library call, so it is
   * created whole or not at all. Opens it and says so; `false` if it failed.
   */
  async importProjectBundle(bundle: unknown, notice: string): Promise<boolean> {
    try {
      const result = await this.api.importBundle(bundle, 'rename');
      await this.refreshList();
      const first = result.imported[0];
      if (first) await this.forceSelect(first.id);
      this.documentState.notify(notice, false);
      return true;
    } catch (error) {
      this.report(error);
      return false;
    }
  }

  /**
   * Sync replaced these shaders underneath the editor. If the open one is among
   * them, re-open it; an unsaved draft goes to its recovery copy first, so the
   * usual "restore unsaved changes?" prompt offers it back over the new record.
   */
  async reloadReplaced(ids: readonly string[]): Promise<void> {
    const id = this.selectedId();
    if (!id || !ids.includes(id)) return;
    this.recovery.flush();
    await this.forceSelect(id);
  }

  /** `select`, but reloads even if the id is already the open one. */
  private forceSelect(id: string): Promise<void> {
    return this.selection.forceSelect(id);
  }

  // --- Misc ---------------------------------------------------------------

  private report(error: unknown): void {
    reportWorkspaceError(error, this.documentState, this.outputLog);
  }
}
