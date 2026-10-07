import {
  Component,
  computed,
  input,
  output,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_EDITOR_APPEARANCE, DEFAULT_EDITOR_WINDOW } from '@shadergrove/shared/editor-prefs';
import { FILE_EXPLORER_LIMITS } from '@shadergrove/shared/panel-prefs';
import {
  addBuffer,
  addFile,
  displayPasses,
  imagePass,
  migrateLegacyProject,
  resolvePassOrder,
  type ShaderProject,
} from '@shadergrove/shared/project';
import { migrateLayoutFromPreferences } from '@shadergrove/shared/surfaces';
import {
  Preferences,
  createDefaultWorkspacePreferences,
  type WorkspacePreferences,
} from '../../prefs/preferences';
import { I18n } from '../../i18n/i18n';
import { ShaderStore, type EditorDocument } from '../../workspace/shader-store';
import { WorkspaceActions } from '../workspace-actions';
import { EditorNavigation, type EditorLocationRequest } from '../../editor/editor-navigation';
import { CodeEditor, type EditorDoc } from '../../editor/code-editor';
import { EditorSettings } from '../../editor/editor-settings';
import { DocumentStatus } from './document-status';
import { ControlsBuilder } from './controls-builder';
import { EditorPanel } from './editor-panel';
import { EditorTabs } from './editor-tabs';
import { EditorWindowControls } from './editor-window-controls';
import { EditorGroupSession } from './editor-group-session';
import { EditorGroups } from './editor-groups';
import { OpenDocuments } from './open-documents';
import { PassConfigPanel } from '../inspector/pass-config-panel';

const FRAGMENT = 'void main() { gl_FragColor = vec4(1.0); }';
const VERTEX = 'void main() { gl_Position = vec4(position, 1.0); }';

@Component({
  selector: 'app-code-editor',
  standalone: true,
  template: '',
})
class CodeEditorStub {
  readonly doc = input.required<EditorDoc>();
  readonly liveIds = input<readonly string[] | null>(null);
  readonly diagnostics = input<readonly unknown[]>([]);
  readonly appearance = input(DEFAULT_EDITOR_APPEARANCE);
  readonly valueChange = output<{ id: string; value: string }>();

  layoutCalls = 0;
  focusCalls = 0;
  applied: Array<{ id: string; value: string }> = [];
  applyResult = true;

  applyEdit(id: string, value: string): boolean {
    this.applied.push({ id, value });
    return this.applyResult;
  }

  layout(): void {
    this.layoutCalls += 1;
  }

  focus(): void {
    this.focusCalls += 1;
  }

  revealIn(): void {}

  async format(): Promise<void> {}
}

@Component({
  selector: 'app-controls-builder',
  standalone: true,
  template: '',
})
class ControlsBuilderStub {
  readonly commit = output<string>();
  readonly repair = output<void>();

  /** What `guard` should do with the action: run it now, or hold it as a pending form would. */
  held: Array<() => void> = [];
  holding = false;

  guard(action: () => void): void {
    if (this.holding) this.held.push(action);
    else action();
  }
}

@Component({
  selector: 'app-editor-tabs',
  standalone: true,
  template: '',
})
class EditorTabsStub {
  readonly activeId = input<string | null>(null);
  readonly select = output<string>();
  readonly closed = output<string | null>();

  focusTab(): void {}
}

@Component({
  selector: 'app-editor-window-controls',
  standalone: true,
  template: '',
})
class EditorWindowControlsStub {}

@Component({
  selector: 'app-pass-config-panel',
  standalone: true,
  template: '',
})
class PassConfigPanelStub {
  readonly pass = input.required<unknown>();
}

function makeProject(): ShaderProject {
  let project = migrateLegacyProject(FRAGMENT, VERTEX);
  project = addBuffer(project);
  project = addFile(project, 'lib.glsl');
  return project;
}

function toDocuments(project: ShaderProject): EditorDocument[] {
  return [
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
    { id: '@vertex', kind: 'vertex', name: 'Vertex', language: 'glsl', source: project.vertex },
    { id: '@config', kind: 'config', name: 'Config', language: 'json', source: '[]' },
  ];
}

class FakePreferences implements Partial<Preferences> {
  private readonly state = signal<WorkspacePreferences>({
    ...createDefaultWorkspacePreferences(),
    editorOpen: true,
    browserWidth: 300,
    inspectorWidth: 300,
    editorWindow: { ...DEFAULT_EDITOR_WINDOW, dockSide: 'right' },
    surfacesLayout: migrateLayoutFromPreferences({
      editorOpen: true,
      editorWindow: { ...DEFAULT_EDITOR_WINDOW, dockSide: 'right' },
    }),
  });

  readonly value = this.state.asReadonly();
  readonly resolved = signal<'dark'>('dark').asReadonly();

  patch(patch: Partial<WorkspacePreferences>): void {
    this.state.update((current) => ({ ...current, ...patch }));
  }
}

class FakeStore implements Partial<ShaderStore> {
  private readonly projectState = signal<ShaderProject | null>(makeProject());
  private readonly documentsState = signal<readonly EditorDocument[]>(
    toDocuments(this.projectState()!),
  );
  private readonly activeId = signal<string | null>(imagePass(this.projectState()!).id);
  private readonly renderOrderState = signal(resolvePassOrder(this.projectState()!).order);
  readonly selectedId = signal('waves').asReadonly() as ShaderStore['selectedId'];
  readonly loading = signal(false) as ShaderStore['loading'];
  readonly dirty = signal(false) as ShaderStore['dirty'];
  readonly saving = signal(false) as ShaderStore['saving'];
  readonly draft = signal({}) as unknown as ShaderStore['draft'];
  readonly configValid = signal(true);
  readonly compiling = signal<ReadonlySet<string>>(new Set()) as ShaderStore['compiling'];
  readonly canAddBuffer = signal(true) as unknown as ShaderStore['canAddBuffer'];
  readonly renderOrder = computed(() => this.renderOrderState()) as ShaderStore['renderOrder'];

  readonly project = computed(() => this.projectState()) as ShaderStore['project'];
  readonly documents = computed(() => this.documentsState()) as ShaderStore['documents'];
  readonly activeDoc = computed(
    () => this.documentsState().find((doc) => doc.id === this.activeId()) ?? null,
  ) as ShaderStore['activeDoc'];

  selectDoc(id: string): void {
    this.activeId.set(id);
  }

  diagnosticsFor(): never[] {
    return [];
  }

  errorCountFor(): number {
    return 0;
  }

  readonly setDocSource = vi.fn();

  setProject(project: ShaderProject | null): void {
    this.projectState.set(project);
    this.documentsState.set(project ? toDocuments(project) : []);
    this.renderOrderState.set(project ? resolvePassOrder(project).order : []);
    if (project) {
      const active = this.activeId();
      if (!this.documentsState().some((doc) => doc.id === active)) {
        this.activeId.set(imagePass(project).id);
      }
    } else {
      this.activeId.set(null);
    }
  }
}

class FakeSettings implements Partial<EditorSettings> {
  readonly effective = signal(DEFAULT_EDITOR_APPEARANCE).asReadonly();
}

class FakeStatus implements Partial<DocumentStatus> {
  readonly state = signal<'none' | 'unsaved' | 'saving' | 'saved'>('none');
  readonly label = signal('');
  readonly canSave = signal(true);
  readonly saveHint = signal('');
}

describe('EditorPanel file explorer integration', () => {
  let store: FakeStore;
  let preferences: FakePreferences;
  let workspace: {
    renameDocument: ReturnType<typeof vi.fn>;
    deleteDocument: ReturnType<typeof vi.fn>;
    createFile: ReturnType<typeof vi.fn>;
    copyFullGlsl: ReturnType<typeof vi.fn>;
    openEditorSettings: ReturnType<typeof vi.fn>;
    reorderExplorer: ReturnType<typeof vi.fn>;
    runExplorerCommand: ReturnType<typeof vi.fn>;
  };
  let resizeObserverCallback: ((entries: Array<{ contentRect: { width: number } }>) => void) | null;
  let requestAnimationFrameSpy: ReturnType<typeof vi.fn>;
  let navigation: ReturnType<typeof signal<EditorLocationRequest | null>>;

  beforeEach(() => {
    navigation = signal<EditorLocationRequest | null>(null);
    resizeObserverCallback = null;
    requestAnimationFrameSpy = vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrameSpy);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: typeof resizeObserverCallback) {
          resizeObserverCallback = callback as typeof resizeObserverCallback;
        }
        observe(): void {}
        disconnect(): void {}
      },
    );

    store = new FakeStore();
    preferences = new FakePreferences();
    workspace = {
      renameDocument: vi.fn(),
      deleteDocument: vi.fn(),
      createFile: vi.fn(),
      copyFullGlsl: vi.fn(),
      openEditorSettings: vi.fn(),
      reorderExplorer: vi.fn(),
      runExplorerCommand: vi.fn().mockResolvedValue(undefined),
    };

    TestBed.resetTestingModule();
    TestBed.overrideComponent(EditorPanel, {
      remove: {
        imports: [CodeEditor, ControlsBuilder, EditorTabs, EditorWindowControls, PassConfigPanel],
      },
      add: {
        imports: [
          CodeEditorStub,
          ControlsBuilderStub,
          EditorTabsStub,
          EditorWindowControlsStub,
          PassConfigPanelStub,
        ],
      },
    });
    TestBed.configureTestingModule({
      imports: [EditorPanel],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ShaderStore, useValue: store },
        { provide: Preferences, useValue: preferences },
        { provide: WorkspaceActions, useValue: workspace },
        { provide: EditorSettings, useValue: new FakeSettings() },
        { provide: DocumentStatus, useValue: new FakeStatus() },
        { provide: EditorNavigation, useValue: { request: navigation.asReadonly() } },
        { provide: I18n, useValue: { t: (key: string) => key } },
        EditorGroupSession,
        EditorGroups,
        OpenDocuments,
      ],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    TestBed.resetTestingModule();
  });

  function mount() {
    const fixture = TestBed.createComponent(EditorPanel);
    fixture.detectChanges();
    resizeObserverCallback?.([{ contentRect: { width: 900 } }]);
    fixture.detectChanges();
    return fixture;
  }

  function codeEditor(fixture: ReturnType<typeof mount>): CodeEditorStub {
    return fixture.debugElement.query(By.directive(CodeEditorStub))
      .componentInstance as CodeEditorStub;
  }

  function tabs(fixture: ReturnType<typeof mount>): EditorTabsStub {
    return fixture.debugElement.query(By.directive(EditorTabsStub))
      .componentInstance as EditorTabsStub;
  }

  it('syncs explorer selection with the active tab', () => {
    const fixture = mount();
    const buffer = store.documents().find((doc) => doc.passKind === 'buffer');
    expect(buffer).toBeDefined();

    const row = fixture.nativeElement.querySelector(
      `[data-node-id="${buffer!.id}"]`,
    ) as HTMLElement;
    row.click();
    fixture.detectChanges();

    expect(store.activeDoc()?.id).toBe(buffer!.id);
    expect(tabs(fixture).activeId()).toBe(buffer!.id);
  });

  it('persists view and open state across collapse and reopen', () => {
    const fixture = mount();
    const component = fixture.componentInstance;

    component['setExplorerView']('pipeline');
    preferences.patch({ fileExplorerWidth: 312 });
    fixture.detectChanges();

    component['collapseExplorer']();
    fixture.detectChanges();
    expect(preferences.value().fileExplorerOpen).toBe(false);

    component['reopenExplorer']();
    fixture.detectChanges();

    expect(preferences.value().fileExplorerOpen).toBe(true);
    expect(preferences.value().fileExplorerView).toBe('pipeline');
    expect(preferences.value().fileExplorerWidth).toBe(312);
  });

  it('clamps keyboard resize and relayouts Monaco', () => {
    const fixture = mount();
    const editor = codeEditor(fixture);
    const resizer = fixture.nativeElement.querySelector('.explorer-resizer') as HTMLElement;

    resizer.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }),
    );
    fixture.detectChanges();

    expect(preferences.value().fileExplorerWidth).toBe(FILE_EXPLORER_LIMITS.width.max);
    expect(editor.layoutCalls).toBeGreaterThan(0);
  });

  it('switches to an overlay at narrow widths and reopens after scrim close', () => {
    const fixture = mount();

    resizeObserverCallback?.([{ contentRect: { width: 420 } }]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.explorer-overlay')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.explorer-resizer')).toBeNull();

    (fixture.nativeElement.querySelector('.explorer-scrim') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.explorer-overlay')).toBeNull();
    expect(fixture.nativeElement.querySelector('.explorer-reopen')).not.toBeNull();

    fixture.componentInstance['reopenExplorer']();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.explorer-overlay')).not.toBeNull();
  });

  it('routes explorer commands through workspace actions and restores explorer focus', async () => {
    const fixture = mount();
    const buffer = store.documents().find((doc) => doc.passKind === 'buffer');
    expect(buffer).toBeDefined();

    await fixture.componentInstance['onExplorerCommand']({ command: 'rename', docId: buffer!.id });
    await Promise.resolve();
    fixture.detectChanges();

    expect(workspace.runExplorerCommand).toHaveBeenCalledWith('rename', buffer!.id);
    expect((document.activeElement as HTMLElement | null)?.dataset['nodeId']).toBe(buffer!.id);
  });

  it('shows loading and no-project explorer states', () => {
    const fixture = mount();

    store.loading.set(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('explorer.state.loading');

    store.loading.set(false);
    store.setProject(null);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('explorer.state.noProject');
  });
  describe('Config views', () => {
    function builder(fixture: ReturnType<typeof mount>): ControlsBuilderStub {
      return fixture.debugElement.query(By.directive(ControlsBuilderStub))
        .componentInstance as ControlsBuilderStub;
    }

    function openConfig(fixture: ReturnType<typeof mount>): void {
      store.selectDoc('@config');
      fixture.detectChanges();
    }

    function editorHost(fixture: ReturnType<typeof mount>): HTMLElement {
      return fixture.nativeElement.querySelector('app-code-editor') as HTMLElement;
    }

    function builderHost(fixture: ReturnType<typeof mount>): HTMLElement {
      return fixture.nativeElement.querySelector('app-controls-builder') as HTMLElement;
    }

    it('shows the builder for a valid Config and keeps the editor alive behind it', () => {
      const fixture = mount();
      expect(fixture.nativeElement.querySelector('.view-bar')).toBeNull();

      openConfig(fixture);

      expect(fixture.nativeElement.querySelector('.view-bar')).not.toBeNull();
      expect(builderHost(fixture).hidden).toBe(false);
      expect(editorHost(fixture).hidden).toBe(true);
      expect(codeEditor(fixture)).toBeDefined();
    });

    it('toggles to the JSON without rebuilding either view', () => {
      const fixture = mount();
      openConfig(fixture);
      const editor = codeEditor(fixture);
      const view = builder(fixture);

      (fixture.nativeElement.querySelector('.view-json') as HTMLButtonElement).click();
      fixture.detectChanges();

      expect(editorHost(fixture).hidden).toBe(false);
      expect(builderHost(fixture).hidden).toBe(true);
      expect(codeEditor(fixture)).toBe(editor);
      expect(builder(fixture)).toBe(view);
    });

    it('does not leave the builder while it holds an unapplied form', () => {
      const fixture = mount();
      openConfig(fixture);
      const view = builder(fixture);
      view.holding = true;

      (fixture.nativeElement.querySelector('.view-json') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(builderHost(fixture).hidden).toBe(false);

      view.held[0]();
      fixture.detectChanges();
      expect(builderHost(fixture).hidden).toBe(true);
    });

    it('opens an invalid Config in JSON and a newly selected valid one in the builder', () => {
      store.configValid.set(false);
      const fixture = mount();
      openConfig(fixture);
      expect(editorHost(fixture).hidden).toBe(false);
      expect(builderHost(fixture).hidden).toBe(true);
    });

    it('opens JSON for a source line and the builder for a plain visit', () => {
      const fixture = mount();
      openConfig(fixture);
      const component = fixture.componentInstance;
      const request = (line: number): EditorLocationRequest => ({
        docId: '@config',
        line,
        requestId: line + 1,
      });

      navigation.set(request(4));
      fixture.detectChanges();
      expect(component['configView']()).toBe('json');

      navigation.set(request(0));
      fixture.detectChanges();
      expect(component['configView']()).toBe('builder');
      expect(store.activeDoc()?.id).toBe('@config');
    });

    it('opens JSON on any visit to a Config the builder cannot read', () => {
      const fixture = mount();
      openConfig(fixture);
      store.configValid.set(false);

      navigation.set({ docId: '@config', line: 0, requestId: 1 });
      fixture.detectChanges();

      expect(fixture.componentInstance['configView']()).toBe('json');
    });

    it('writes a builder commit through the Config model so it can be undone', () => {
      const fixture = mount();
      openConfig(fixture);

      builder(fixture).commit.emit('[1]');

      expect(codeEditor(fixture).applied).toEqual([{ id: '@config', value: '[1]' }]);
      expect(store.setDocSource).not.toHaveBeenCalled();
    });

    it('writes the store directly when there is no Config model yet', () => {
      const fixture = mount();
      openConfig(fixture);
      codeEditor(fixture).applyResult = false;

      builder(fixture).commit.emit('[2]');

      expect(store.setDocSource).toHaveBeenCalledOnce();
      expect(store.setDocSource).toHaveBeenCalledWith('@config', '[2]');
    });

    it('scopes the Config document to the shader that owns it', () => {
      const fixture = mount();
      openConfig(fixture);

      expect(codeEditor(fixture).doc().scope).toBe('waves');
      store.selectDoc(store.documents()[0].id);
      fixture.detectChanges();
      expect(codeEditor(fixture).doc().scope).toBeUndefined();
    });
  });
});
