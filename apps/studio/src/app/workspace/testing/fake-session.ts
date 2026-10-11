import { computed, signal, type Provider } from '@angular/core';
import { vi } from 'vitest';

import type { CompileDiagnostic } from '@shadergrove/shared/diagnostic';
import { DEFAULT_EDITOR_APPEARANCE } from '@shadergrove/shared/editor-prefs';
import {
  DEFAULT_CHANNELS,
  DEFAULT_RENDER,
  type Preset,
  type RenderSettings,
  type ShaderControl,
  type ShaderParams,
} from '@shadergrove/shared/model';
import type { InspectorTab } from '@shadergrove/shared/panel-prefs';
import {
  addBuffer,
  addFile,
  NO_BINDING,
  PROJECT_VERSION,
  displayPasses,
  freeSlot,
  makePass,
  removeFile,
  removePass,
  renameFile,
  renamePass,
  setPassEnabled,
  type ShaderProject,
} from '@shadergrove/shared/project';
import { EditorSettings } from '../../editor/editor-settings';
import {
  Preferences,
  createDefaultWorkspacePreferences,
  type WorkspacePreferences,
} from '../../prefs/preferences';
import { RendererHandle } from '../../rendering/renderer-handle';
import { SurfaceLayoutService } from '../../surfaces/surface-layout';
import { WorkspaceActions } from '../../ui/workspace-actions';
import { ShaderStore } from '../shader-store';
import type { EditorDocument } from '../state/document-state';

export const FAKE_CONTROLS: ShaderControl[] = [
  { key: 'speed', type: 'number', default: 1, min: 0, max: 10 },
  { key: 'glow', type: 'boolean', default: false },
];

export const FAKE_DOCUMENTS: EditorDocument[] = [
  { id: 'image', kind: 'pass', name: 'Image', language: 'glsl', source: 'void main() {}' },
  { id: '@config', kind: 'config', name: 'Config', language: 'json', source: '[]' },
];

/**
 * A project with what the explorer can change: Image, two buffers (B samples A)
 * and an included file. Show it with `FakeMainSession.useProject`.
 */
export function explorerProject(): ShaderProject {
  return {
    version: PROJECT_VERSION,
    vertex: '',
    passes: [
      makePass({ id: 'image', kind: 'image', name: 'Image', source: FAKE_DOCUMENTS[0].source }),
      makePass({ id: 'buf-a', kind: 'buffer', name: 'Buffer A', slot: 'A', source: 'a' }),
      makePass({
        id: 'buf-b',
        kind: 'buffer',
        name: 'Buffer B',
        slot: 'B',
        source: 'b',
        channels: [
          { kind: 'buffer', passId: 'buf-a', feedback: false },
          NO_BINDING,
          NO_BINDING,
          NO_BINDING,
        ],
      }),
    ],
    files: [{ id: 'file-1', name: 'noise.glsl', source: 'float noise;' }],
  };
}

/**
 * The main window's session as `SessionHost` and the inspector's main-window
 * session see it: signals to drive from a test, and spies for every change a
 * panel window may ask for. Nothing here touches a library.
 */
export class FakeMainSession {
  readonly record = signal<{ id: string; updatedAt: string } | null>({
    id: 'waves',
    updatedAt: '2024-01-01T00:00:00.000Z',
  });
  readonly loading = signal(false);
  readonly staleRecovery = signal<object | null>(null);
  readonly saving = signal(false);
  readonly dirty = signal(false);
  readonly allDiagnostics = signal<readonly CompileDiagnostic[]>([]);
  readonly controls = signal<readonly ShaderControl[]>(FAKE_CONTROLS);
  readonly params = signal<ShaderParams>({ speed: 1, glow: false });
  readonly presets = signal<readonly Preset[]>([]);
  readonly activePresetId = signal<string | null>(null);
  readonly channels = signal(DEFAULT_CHANNELS);
  readonly render = signal<RenderSettings>(DEFAULT_RENDER);
  readonly documents = signal<readonly EditorDocument[]>(FAKE_DOCUMENTS);
  readonly activeDocId = signal('image');
  readonly notice = signal<{ text: string; error: boolean } | null>(null);

  readonly preferences = signal<WorkspacePreferences>(createDefaultWorkspacePreferences());
  readonly native = signal({ bottomPanel: false, inspector: false, editor: false });
  readonly inspectorTab = signal<InspectorTab>('controls');
  /** Whether each native panel's window is open, for the layout's `isWindowOpen`. */
  readonly windowOpen = signal(true);
  readonly fps = signal(60);
  /** The project behind `documents`, once a test gives one (`useProject`); the explorer's source. */
  readonly project = signal<ShaderProject | null>(null);

  /** Shows a project, its documents derived from it as the store derives them. */
  useProject(project: ShaderProject): void {
    this.project.set(project);
    this.documents.set([
      ...displayPasses(project).map(
        (pass): EditorDocument => ({
          id: pass.id,
          kind: 'pass',
          name: pass.name,
          language: 'glsl',
          source: pass.source,
          passKind: pass.kind,
          slot: pass.slot,
          enabled: pass.enabled,
        }),
      ),
      ...project.files.map(
        (file): EditorDocument => ({
          id: file.id,
          kind: 'file',
          name: file.name,
          language: 'glsl',
          source: file.source,
        }),
      ),
      FAKE_DOCUMENTS[1],
    ]);
  }

  /** A change to the project, as the store makes it; `select` opens a document, as it does. */
  private change(next: (project: ShaderProject) => ShaderProject, select?: string): void {
    const project = this.project();
    if (!project) return;
    this.useProject(next(project));
    if (select) this.activeDocId.set(select);
    else if (!this.documents().some((document) => document.id === this.activeDocId())) {
      this.activeDocId.set('image');
    }
  }

  readonly store = {
    record: this.record,
    selectedId: computed(() => this.record()?.id ?? null),
    loading: this.loading,
    staleRecovery: this.staleRecovery,
    saving: this.saving,
    dirty: this.dirty,
    allDiagnostics: this.allDiagnostics,
    controls: this.controls,
    params: this.params,
    presets: this.presets,
    activePresetId: this.activePresetId,
    channels: this.channels,
    draft: computed(() => ({ render: this.render() })),
    documents: this.documents,
    activeDoc: computed(
      () => this.documents().find((document) => document.id === this.activeDocId()) ?? null,
    ),
    passes: () => [],
    notice: this.notice,
    setDocSource: vi.fn((docId: string, source: string) => {
      const project = this.project();
      // A pass or file of a shown project is written there, so a later rename keeps the text.
      if (project && [...project.passes, ...project.files].some((each) => each.id === docId)) {
        const write = <T extends { id: string }>(each: T) =>
          each.id === docId ? { ...each, source } : each;
        this.useProject({
          ...project,
          passes: project.passes.map(write),
          files: project.files.map(write),
        });
        return;
      }
      this.documents.update((documents) =>
        documents.map((document) => (document.id === docId ? { ...document, source } : document)),
      );
    }),
    selectDoc: vi.fn((docId: string) => this.activeDocId.set(docId)),
    setParam: vi.fn((key: string, value: ShaderParams[string]) =>
      this.params.update((params) => ({ ...params, [key]: value })),
    ),
    resetParams: vi.fn(),
    setRender: vi.fn((render: RenderSettings) => this.render.set(render)),
    applyPreset: vi.fn(),
    savePreset: vi.fn(async () => undefined),
    deletePreset: vi.fn(async () => undefined),
    setTextureImage: vi.fn(async () => undefined),
    clearTextureImage: vi.fn(async () => undefined),
    setChannelSettings: vi.fn(async () => undefined),
    save: vi.fn(async () => true),
    // The explorer.
    project: this.project,
    compiling: signal<ReadonlySet<string>>(new Set()),
    errorCountFor: (docId: string) =>
      this.allDiagnostics().filter(
        (diagnostic) => diagnostic.docId === docId && diagnostic.severity === 'error',
      ).length,
    renderOrder: computed(() => this.project()?.passes.filter((pass) => pass.enabled) ?? []),
    canAddBuffer: computed(() => {
      const project = this.project();
      return project !== null && freeSlot(project) !== null;
    }),
    addSourceFile: vi.fn((name: string) => {
      const project = this.project();
      if (!project) return;
      const next = addFile(project, name);
      this.change(() => next, next.files.at(-1)?.id);
    }),
    addBufferPass: vi.fn(() => {
      const project = this.project();
      if (!project) return;
      const next = addBuffer(project);
      this.change(() => next, next.passes.at(-1)?.id);
    }),
    renameSourceFile: vi.fn((id: string, name: string) =>
      this.change((project) => renameFile(project, id, name)),
    ),
    renamePassById: vi.fn((id: string, name: string) =>
      this.change((project) => renamePass(project, id, name)),
    ),
    duplicateSourceFile: vi.fn(),
    duplicateBufferPass: vi.fn(),
    removeSourceFile: vi.fn((id: string) => this.change((project) => removeFile(project, id))),
    removeBufferPass: vi.fn((id: string) => this.change((project) => removePass(project, id))),
    setPassEnabledById: vi.fn((id: string, enabled: boolean) =>
      this.change((project) => setPassEnabled(project, id, enabled)),
    ),
    moveSourceFile: vi.fn(),
    movePassTo: vi.fn(),
  };

  readonly layout = {
    bottomPanelId: 'surface:bottom-panel',
    inspectorId: 'surface:inspector',
    editorId: 'surface:editor:editor-group:default',
    isWindowOpen: () => this.windowOpen(),
    bottomPanelNative: computed(() => this.native().bottomPanel),
    inspectorNative: computed(() => this.native().inspector),
    editorNative: computed(() => this.native().editor),
    anyNative: computed(() => Object.values(this.native()).some(Boolean)),
    inspectorTab: this.inspectorTab,
    setInspectorTab: vi.fn((tab: InspectorTab) => this.inspectorTab.set(tab)),
    openEditor: vi.fn(() => true),
    close: vi.fn(),
  };

  readonly renderer = {
    fps: this.fps,
    engine: signal(null),
    profilerEpoch: signal(0),
    setProfilingEnabled: vi.fn(),
    profilerSnapshot: () => null,
    resetProfilerSamples: vi.fn(),
    screenshot: vi.fn(async () => true),
  };

  readonly workspace = { savePreset: vi.fn(), deletePreset: vi.fn() };

  providers(): Provider[] {
    return [
      { provide: ShaderStore, useValue: this.store },
      { provide: SurfaceLayoutService, useValue: this.layout },
      { provide: RendererHandle, useValue: this.renderer },
      { provide: WorkspaceActions, useValue: this.workspace },
      {
        provide: Preferences,
        useValue: {
          value: this.preferences.asReadonly(),
          patch: (patch: Partial<WorkspacePreferences>) =>
            this.preferences.update((current) => ({ ...current, ...patch })),
        },
      },
      {
        provide: EditorSettings,
        useValue: { effective: signal(DEFAULT_EDITOR_APPEARANCE).asReadonly() },
      },
    ];
  }
}
