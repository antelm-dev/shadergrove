import { computed, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONFIG_DOC, VERTEX_DOC } from '@shadergrove/shared/diagnostic';
import {
  addBuffer,
  addFile,
  bufferPasses,
  displayPasses,
  imagePass,
  migrateLegacyProject,
  type ShaderProject,
} from '@shadergrove/shared/project';
import { I18n } from '../../i18n/i18n';
import { ShaderStore, type EditorDocument } from '../../workspace/shader-store';
import {
  buildExplorerTree,
  collectSelectableDocIds,
  type ExplorerViewMode,
} from '../file-explorer';
import { EditorGroupSession } from './editor-group-session';
import { EditorGroups } from './editor-groups';
import { EditorTabs } from './editor-tabs';
import { OpenDocuments } from './open-documents';

const FRAGMENT = 'void main() { gl_FragColor = vec4(1.0); }';
const VERTEX = 'void main() { gl_Position = vec4(position, 1.0); }';

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
    { id: VERTEX_DOC, kind: 'vertex', name: 'Vertex', language: 'glsl', source: project.vertex },
    { id: CONFIG_DOC, kind: 'config', name: 'Config', language: 'json', source: '{}' },
  ];
}

class TabStore {
  private project = (() => {
    let next = migrateLegacyProject(FRAGMENT, VERTEX);
    next = addBuffer(next);
    next = addFile(next, 'noise.glsl');
    return next;
  })();

  readonly selectedId = signal<string | null>('waves');
  readonly documentsState = signal<readonly EditorDocument[]>(toDocuments(this.project));
  readonly activeId = signal<string | null>(imagePass(this.project).id);
  readonly dirty = signal(false);
  readonly compiling = signal<ReadonlySet<string>>(new Set());

  readonly documents = this.documentsState.asReadonly();
  readonly activeDoc = computed(
    () =>
      this.documentsState().find((doc) => doc.id === this.activeId()) ??
      this.documentsState()[0] ??
      null,
  );

  asShaderStore(): ShaderStore {
    return {
      selectedId: this.selectedId.asReadonly(),
      documents: this.documents,
      activeDoc: this.activeDoc,
      dirty: this.dirty.asReadonly(),
      compiling: this.compiling.asReadonly(),
      selectDoc: (id: string) => this.activeId.set(id),
      errorCountFor: () => 0,
      project: computed(() => this.project),
      canAddBuffer: computed(() => true),
      renderOrder: computed(() => displayPasses(this.project)),
      loading: signal(false).asReadonly(),
    } as unknown as ShaderStore;
  }

  renameFile(id: string, name: string): void {
    this.project = {
      ...this.project,
      files: this.project.files.map((file) => (file.id === id ? { ...file, name } : file)),
    };
    this.documentsState.set(toDocuments(this.project));
  }

  removeBuffer(id: string): void {
    this.project = {
      ...this.project,
      passes: this.project.passes.filter((pass) => pass.id !== id),
    };
    this.documentsState.set(toDocuments(this.project));
    if (this.activeId() === id) this.activeId.set(imagePass(this.project).id);
  }

  currentProject(): ShaderProject {
    return this.project;
  }
}

describe('EditorTabs open-document strip', () => {
  let tabs: TabStore;
  let openDocs: OpenDocuments;

  beforeEach(() => {
    tabs = new TabStore();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [EditorTabs],
      providers: [
        provideZonelessChangeDetection(),
        { provide: ShaderStore, useValue: tabs.asShaderStore() },
        {
          provide: I18n,
          useValue: {
            t: (key: string, params: Record<string, string | number> = {}) =>
              key === 'editor.closeTab' ? `Close ${params['name']}` : key,
          },
        },
        EditorGroupSession,
        EditorGroups,
        OpenDocuments,
      ],
    });
    openDocs = TestBed.inject(OpenDocuments);
    TestBed.tick();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  function mountTabs(activeId = tabs.activeId()) {
    const fixture = TestBed.createComponent(EditorTabs);
    fixture.componentRef.setInput('activeId', activeId);
    fixture.detectChanges();
    return fixture;
  }

  it('renders only the initially open document, not every project doc', () => {
    const fixture = mountTabs();
    const tabButtons = fixture.nativeElement.querySelectorAll('[role="tab"]');
    expect(tabButtons).toHaveLength(1);
    expect(tabButtons[0].textContent).toContain('Image');
    expect(fixture.nativeElement.querySelector('.tab.add')).toBeNull();
    expect(openDocs.openIds()).toHaveLength(1);
  });

  it('opens from activation without duplicating and keeps explorer listing all docs', () => {
    openDocs.activate(VERTEX_DOC);
    openDocs.activate(VERTEX_DOC);
    TestBed.tick();

    const fixture = mountTabs(VERTEX_DOC);
    expect(fixture.nativeElement.querySelectorAll('[role="tab"]')).toHaveLength(2);

    const project = tabs.currentProject();
    const tree = buildExplorerTree({
      view: 'files' satisfies ExplorerViewMode,
      loading: false,
      project,
      documents: tabs.documentsState(),
      activeDocId: VERTEX_DOC,
      dirty: false,
      compiling: new Set(),
      errorCountFor: () => 0,
      renderOrder: displayPasses(project),
      canAddBuffer: true,
    });

    const leafIds = new Set(collectSelectableDocIds(tree));
    expect(leafIds.size).toBeGreaterThan(2);
    expect(leafIds.has(imagePass(project).id)).toBe(true);
    expect(leafIds.has(VERTEX_DOC)).toBe(true);
    expect(leafIds.has(CONFIG_DOC)).toBe(true);
    expect(leafIds.has(bufferPasses(project)[0]!.id)).toBe(true);
    expect(leafIds.has(project.files[0]!.id)).toBe(true);
  });

  it('exposes a localized close control and refuses last-tab close', () => {
    openDocs.activate(VERTEX_DOC);
    TestBed.tick();
    const fixture = mountTabs(VERTEX_DOC);

    const close = fixture.nativeElement.querySelector('.tab-close') as HTMLButtonElement;
    expect(close).toBeTruthy();
    expect(close.getAttribute('aria-label')).toMatch(/Close /);

    close.click();
    TestBed.tick();
    fixture.detectChanges();
    expect(openDocs.openIds()).toHaveLength(1);
    expect(fixture.nativeElement.querySelector('.tab-close')).toBeNull();
  });

  it('supports keyboard activation and Delete-to-close', () => {
    const imageId = tabs.activeId()!;
    openDocs.activate(VERTEX_DOC);
    openDocs.activate(CONFIG_DOC);
    TestBed.tick();

    const fixture = mountTabs(CONFIG_DOC);
    const tabButtons = fixture.debugElement.queryAll(By.css('[role="tab"]'));
    expect(tabButtons).toHaveLength(3);

    let selected: string | null = null;
    fixture.componentInstance.select.subscribe((id) => (selected = id));
    tabButtons[2].triggerEventHandler(
      'keydown',
      new KeyboardEvent('keydown', { key: 'ArrowLeft' }),
    );
    expect(selected).toBe(VERTEX_DOC);

    openDocs.activate(VERTEX_DOC);
    fixture.componentRef.setInput('activeId', VERTEX_DOC);
    fixture.detectChanges();

    const vertexTab = fixture.debugElement
      .queryAll(By.css('[role="tab"]'))
      .find((el) => el.nativeElement.getAttribute('data-doc-id') === VERTEX_DOC)!;
    vertexTab.triggerEventHandler('keydown', new KeyboardEvent('keydown', { key: 'Delete' }));
    TestBed.tick();
    fixture.detectChanges();

    expect(openDocs.openIds()).toEqual([imageId, CONFIG_DOC]);
    expect(tabs.activeId()).toBe(CONFIG_DOC);
  });

  it('updates the open tab label in place after rename', () => {
    const fileId = tabs.currentProject().files[0]!.id;
    openDocs.activate(fileId);
    TestBed.tick();

    const fixture = mountTabs(fileId);
    expect(fixture.nativeElement.textContent).toContain('noise.glsl');

    tabs.renameFile(fileId, 'util.glsl');
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('util.glsl');
    expect(openDocs.openIds()).toContain(fileId);
  });

  it('drops a deleted buffer from the open set', () => {
    const bufferId = bufferPasses(tabs.currentProject())[0]!.id;
    openDocs.activate(bufferId);
    TestBed.tick();
    expect(openDocs.openIds()).toContain(bufferId);

    tabs.removeBuffer(bufferId);
    TestBed.tick();
    expect(openDocs.openIds()).not.toContain(bufferId);
  });

  it('reorders open tabs without changing project buffer order', () => {
    const imageId = imagePass(tabs.currentProject()).id;
    const bufferId = bufferPasses(tabs.currentProject())[0]!.id;
    openDocs.activate(bufferId);
    TestBed.tick();

    const before = tabs.currentProject().passes.map((pass) => pass.id);
    openDocs.reorder(bufferId, imageId);
    expect(openDocs.openIds()).toEqual([bufferId, imageId]);
    expect(tabs.currentProject().passes.map((pass) => pass.id)).toEqual(before);
  });

  it('lists and closes tabs per explicit group, reporting that group active document', () => {
    const groups = TestBed.inject(EditorGroups);
    const imageId = tabs.activeId()!;
    const bufferId = bufferPasses(tabs.currentProject())[0]!.id;
    const second = groups.createGroup()!;
    groups.activate(bufferId, second);
    groups.activate(VERTEX_DOC, second);
    TestBed.tick();

    const primary = mountTabs();
    const other = mountTabs(VERTEX_DOC);
    other.componentRef.setInput('groupId', second);
    other.detectChanges();

    const ids = (fixture: typeof primary) =>
      fixture.debugElement
        .queryAll(By.css('[role="tab"]'))
        .map((el) => el.nativeElement.getAttribute('data-doc-id'));
    expect(ids(primary)).toEqual([imageId]);
    expect(ids(other)).toEqual([bufferId, VERTEX_DOC]);

    // The global pick is the vertex tab, but closing the buffer tab in the
    // second group must not disturb the first group.
    let next: string | null | undefined;
    other.componentInstance.closed.subscribe((id) => (next = id));
    (
      other.debugElement.queryAll(By.css('.tab-close'))[0].nativeElement as HTMLButtonElement
    ).click();
    TestBed.tick();
    other.detectChanges();

    expect(groups.openIds(second)).toEqual([VERTEX_DOC]);
    expect(groups.openIds()).toEqual([imageId]);
    expect(next).toBe(groups.activeDocumentId(second));
    expect(next).toBe(VERTEX_DOC);
  });
});
