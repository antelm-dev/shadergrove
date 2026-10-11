import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { By, Title } from '@angular/platform-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_EDITOR_GROUP_ID, editorSurfaceId } from '@shadergrove/shared/surfaces';
import { DesktopPlatform } from '../../desktop/desktop-platform';
import { MONACO_LOADER } from '../../editor/code-editor';
import { FontLoader } from '../../editor/google-fonts';
import { editors, fakeMonaco, models, type FakeModel } from '../../editor/testing/fake-monaco';
import { I18n } from '../../i18n/i18n';
import { provideTestLanguages, speaking } from '../../i18n/testing/languages';
import { Preferences } from '../../prefs/preferences';
import { ReducedMotion } from '../../prefs/reduced-motion';
import { AppThemes } from '../../themes/app-themes';
import {
  SESSION_CHANNEL,
  type SessionMessage,
} from '../../workspace/session-sync/session-protocol';
import { FakeBroadcastChannel } from '../../workspace/testing/fake-broadcast-channel';
import { textFingerprint } from '../../workspace/session-sync/session-protocol';
import {
  FAKE_DOCUMENTS,
  FakeMainSession,
  explorerProject,
} from '../../workspace/testing/fake-session';
import { forbidMainWindowOnly } from '../../workspace/testing/main-window-only';
import { DocumentDialogs } from '../dialogs/document-dialogs';
import { ExplorerPanel, buildExplorerTree } from '../file-explorer';
import { EditorWindow } from './editor-window';

const IMAGE = 'void main() {}';

describe('EditorWindow (the editor in its own window)', () => {
  const desktop = {
    available: true,
    maximized: signal(false),
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    returnSurface: vi.fn(async () => ({ status: 'returned', surfaceId: '' })),
    closeSurface: vi.fn(async () => ({ status: 'closed', surfaceId: '' })),
  };
  const dialogs = {
    askNewFileName: vi.fn(async (): Promise<string | undefined> => 'fresh.glsl'),
    askRename: vi.fn(async (): Promise<string | undefined> => 'Blur'),
    confirmDelete: vi.fn(async () => true),
  };
  let preferences: ReturnType<typeof signal<Record<string, unknown>>>;
  let main: FakeBroadcastChannel;
  let received: SessionMessage[];
  let fixture: ComponentFixture<EditorWindow>;

  beforeEach(async () => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    models.length = 0;
    editors.length = 0;
    desktop.returnSurface.mockClear();
    desktop.closeSurface.mockClear();
    desktop.minimize.mockClear();
    desktop.toggleMaximize.mockClear();
    preferences = signal<Record<string, unknown>>({
      ...speaking('en'),
      fileExplorerOpen: false,
      fileExplorerWidth: 240,
    });
    main = new FakeBroadcastChannel(SESSION_CHANNEL);
    received = [];
    main.onmessage = ({ data }) => received.push(data as SessionMessage);

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        I18n,
        provideTestLanguages(),
        {
          provide: Preferences,
          useValue: {
            value: preferences.asReadonly(),
            patch: (patch: Record<string, unknown>) =>
              preferences.update((value) => ({ ...value, ...patch })),
          },
        },
        { provide: DesktopPlatform, useValue: desktop },
        { provide: DocumentDialogs, useValue: dialogs },
        { provide: MONACO_LOADER, useValue: async () => fakeMonaco },
        { provide: AppThemes, useValue: { attachMonaco: vi.fn() } },
        { provide: FontLoader, useValue: { load: async () => 'idle' } },
        { provide: ReducedMotion, useValue: { enabled: signal(false) } },
        ...forbidMainWindowOnly('editor'),
      ],
    });

    fixture = TestBed.createComponent(EditorWindow);
    await settle();
    publish({
      kind: 'state',
      patch: {
        shader: { id: 'waves', updatedAt: 'v1' },
        documents: FAKE_DOCUMENTS,
        activeDocId: 'image',
      },
    });
    await settle();
    for (let i = 0; i < 10 && models.length === 0; i++) await settle();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    FakeBroadcastChannel.reset();
    vi.unstubAllGlobals();
  });

  async function settle(): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve));
    fixture.detectChanges();
  }

  const publish = (message: SessionMessage) => main.postMessage(message);
  const root = () => fixture.nativeElement as HTMLElement;
  const image = (): FakeModel => models.find((model) => model.getValue().startsWith('void'))!;
  const commands = () =>
    received.flatMap((message) => (message.kind === 'command' ? [message] : []));

  /** What Monaco does on a keystroke: one undoable edit at the end of the text. */
  const type = (model: FakeModel, text: string) => {
    const lines = model.getValue().split('\n');
    const line = lines.length;
    const column = lines[line - 1].length + 1;
    model.pushEditOperations(null, [
      {
        range: {
          startLineNumber: line,
          startColumn: column,
          endLineNumber: line,
          endColumn: column,
        },
        text,
      },
    ]);
  };

  it("edits the main window's document, scoped to its shader, with no session of its own", () => {
    expect(received[0]).toEqual({ kind: 'hello', client: expect.any(String), window: 'editor' });
    expect(
      [...root().querySelectorAll('[role="tab"] .name')].map((tab) => tab.textContent),
    ).toEqual(['Image', 'Config']);

    type(image(), ' // a');

    expect(commands().at(-1)?.command).toEqual({
      kind: 'edit',
      shaderId: 'waves',
      docId: 'image',
      base: textFingerprint(IMAGE),
      source: `${IMAGE} // a`,
    });
  });

  it('names the text a keystroke was typed on, even when newer text has not reached the editor yet', () => {
    // The main window's change has arrived, but no change detection has put it in the model.
    publish({
      kind: 'state',
      patch: {
        documents: FAKE_DOCUMENTS.map((document) =>
          document.id === 'image' ? { ...document, source: 'PATCHED BY MAIN' } : document,
        ),
      },
    });
    type(image(), 'x');

    expect(commands().at(-1)?.command).toMatchObject({
      kind: 'edit',
      base: textFingerprint(IMAGE),
      source: `${IMAGE}x`,
    });
  });

  it("says why a keystroke was refused, and shows the main window's text", async () => {
    const model = image();
    type(model, ' // a');
    const [sent] = commands();
    publish({
      kind: 'state',
      patch: {
        documents: FAKE_DOCUMENTS.map((document) =>
          document.id === 'image' ? { ...document, source: 'PATCHED BY MAIN' } : document,
        ),
      },
    });
    publish({ kind: 'done', client: sent.client, seq: sent.seq, ok: false, reason: 'conflict' });
    await settle();

    expect(model.getValue()).toBe('PATCHED BY MAIN');
    expect(root().querySelector('app-satellite-controls .notice')?.textContent?.trim()).toBe(
      'This document changed in the main window. Your last edit was not applied; the editor now shows the main window’s text.',
    );
  });

  it("keeps what was typed and its undo history while the main window's answer is on its way", async () => {
    const model = image();
    type(model, ' // a');
    type(model, 'b');
    const [first, second] = commands();

    // Posted by the main window before it had the second keystroke.
    publish({
      kind: 'state',
      patch: {
        documents: FAKE_DOCUMENTS.map((document) =>
          document.id === 'image' ? { ...document, source: `${IMAGE} // a` } : document,
        ),
      },
    });
    publish({ kind: 'done', client: first.client, seq: first.seq, ok: true });
    await settle();

    expect(model.getValue()).toBe(`${IMAGE} // ab`);
    expect(model.history).toHaveLength(2);

    publish({
      kind: 'state',
      patch: {
        documents: FAKE_DOCUMENTS.map((document) =>
          document.id === 'image' ? { ...document, source: `${IMAGE} // ab` } : document,
        ),
      },
    });
    publish({ kind: 'done', client: second.client, seq: second.seq, ok: true });
    await settle();

    expect(model.getValue()).toBe(`${IMAGE} // ab`);
    expect(model.history).toHaveLength(2);
  });

  it('takes a change made in the main window when nothing typed here is waiting', async () => {
    publish({
      kind: 'state',
      patch: {
        documents: FAKE_DOCUMENTS.map((document) =>
          document.id === 'image'
            ? { ...document, source: 'void main() { reverted(); }' }
            : document,
        ),
      },
    });
    await settle();

    expect(image().getValue()).toBe('void main() { reverted(); }');
  });

  it('selects documents in the main window, shows unsaved changes and saves there', async () => {
    root().querySelectorAll<HTMLButtonElement>('[role="tab"]')[1].click();
    await settle();
    expect(commands().at(-1)?.command).toEqual({ kind: 'select-doc', docId: '@config' });
    expect(root().querySelector('[role="tab"].active .name')?.textContent).toBe('Config');
    const selected = commands().at(-1)!;
    publish({ kind: 'state', patch: { activeDocId: '@config' } });
    publish({ kind: 'done', client: selected.client, seq: selected.seq, ok: true });

    const save = root().querySelector<HTMLButtonElement>('button.save')!;
    expect(save.disabled).toBe(true);
    publish({ kind: 'state', patch: { dirty: true } });
    await settle();
    expect(root().querySelector('.status')?.textContent).toBe('Unsaved changes');
    expect(save.disabled).toBe(false);

    save.click();
    expect(commands().at(-1)?.command).toEqual({ kind: 'save' });
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }));
    expect(commands().filter((message) => message.command.kind === 'save')).toHaveLength(2);
  });

  it('shows a line the main window asks for', async () => {
    publish({ kind: 'reveal-in-editor', docId: 'image', line: 1 });
    await settle();

    expect(editors[0].revealed).toEqual([1]);
  });

  it('docks back and closes through the satellite surface IPC', () => {
    root().querySelector<HTMLButtonElement>('app-satellite-controls button.dock')!.click();

    expect(desktop.returnSurface).toHaveBeenCalledWith(editorSurfaceId(DEFAULT_EDITOR_GROUP_ID));
  });

  it("wears the main window's title bar, acting on this window only", () => {
    const bar = root().querySelector<HTMLElement>('app-satellite-titlebar .titlebar')!;
    expect(bar.querySelector('.title-text')?.textContent?.trim()).toBe('Editor — Shadergrove');
    expect(TestBed.inject(Title).getTitle()).toBe('Editor — Shadergrove');
    expect(bar.querySelector('.trailing')?.classList.contains('no-drag')).toBe(true);

    bar.querySelector<HTMLButtonElement>('.win-btn.minimize')!.click();
    bar.querySelector<HTMLButtonElement>('.win-btn.maximize')!.click();
    bar.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    bar.querySelector<HTMLButtonElement>('.win-btn.close')!.click();

    expect(desktop.minimize).toHaveBeenCalledOnce();
    expect(desktop.toggleMaximize).toHaveBeenCalledTimes(2);
    // Close hides the editor's window; the editor stays detached.
    expect(desktop.closeSurface).toHaveBeenCalledWith(editorSurfaceId(DEFAULT_EDITOR_GROUP_ID));
    expect(desktop.returnSurface).not.toHaveBeenCalled();
  });

  describe('the project explorer', () => {
    const fake = new FakeMainSession();
    fake.useProject(explorerProject());
    const documents = fake.documents();
    const explorer = {
      tree: buildExplorerTree({
        view: 'files',
        project: explorerProject(),
        documents,
        activeDocId: 'image',
        dirty: true,
        compiling: new Set(),
        errorCountFor: (docId) => (docId === 'buf-a' ? 2 : 0),
        renderOrder: [],
        canAddBuffer: true,
      }),
      canAddBuffer: true,
      consumers: { 'buf-a': ['Buffer B'], 'buf-b': [] },
    };

    beforeEach(async () => {
      dialogs.askNewFileName.mockClear();
      dialogs.askRename.mockClear();
      dialogs.confirmDelete.mockClear();
      publish({ kind: 'state', patch: { documents, explorer } });
      await settle();
    });

    const panel = () =>
      fixture.debugElement.query(By.directive(ExplorerPanel))?.componentInstance as
        | ExplorerPanel
        | undefined;
    const row = (id: string) =>
      root().querySelector<HTMLElement>(`[role="treeitem"][data-node-id="${id}"]`);
    const sent = () => commands().map((message) => message.command);

    it("shows the main window's tree, with its markers, and opens what is clicked", async () => {
      expect(panel()).toBeUndefined();
      root().querySelector<HTMLButtonElement>('button.explorer-reopen')!.click();
      await settle();

      expect(row('buf-a')?.getAttribute('aria-label')).toContain('2');
      expect(row('image')?.classList.contains('active')).toBe(true);
      row('file-1')!.click();
      await settle();
      expect(sent().at(-1)).toEqual({ kind: 'select-doc', docId: 'file-1' });
      expect(root().querySelector('[role="tab"].active .name')?.textContent).toBe('noise.glsl');
    });

    it('asks its questions here and sends only the answers, for the shader they were asked in', async () => {
      preferences.update((value) => ({ ...value, fileExplorerOpen: true }));
      await settle();
      const explorerPanel = panel()!;

      explorerPanel.command.emit({ command: 'rename', docId: 'buf-a' });
      explorerPanel.command.emit({ command: 'delete', docId: 'buf-a' });
      explorerPanel.command.emit({ command: 'duplicate', docId: 'file-1' });
      explorerPanel.command.emit({ command: 'disable', docId: 'buf-b' });
      explorerPanel.command.emit({ command: 'create-file' });
      explorerPanel.command.emit({ command: 'create-buffer' });
      explorerPanel.reorder.emit({ sourceDocId: 'buf-b', targetDocId: 'buf-a', list: 'buffer' });
      explorerPanel.viewChange.emit('pipeline');
      await settle();

      expect(dialogs.askRename).toHaveBeenCalledWith(expect.objectContaining({ id: 'buf-a' }));
      expect(dialogs.confirmDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'buf-a' }), [
        'Buffer B',
      ]);
      const shaderId = 'waves';
      expect(sent()).toEqual(
        expect.arrayContaining([
          { kind: 'rename-doc', shaderId, docId: 'buf-a', name: 'Blur' },
          { kind: 'delete-doc', shaderId, docId: 'buf-a' },
          { kind: 'duplicate-doc', shaderId, docId: 'file-1' },
          { kind: 'set-doc-enabled', shaderId, docId: 'buf-b', enabled: false },
          { kind: 'add-file', shaderId, name: 'fresh.glsl' },
          { kind: 'add-buffer', shaderId },
          { kind: 'move-doc', shaderId, docId: 'buf-b', targetDocId: 'buf-a', list: 'buffer' },
          { kind: 'explorer-view', view: 'pipeline' },
        ]),
      );
    });

    it('sends nothing for a question the user cancelled', async () => {
      preferences.update((value) => ({ ...value, fileExplorerOpen: true }));
      await settle();
      dialogs.askRename.mockResolvedValueOnce(undefined);
      dialogs.confirmDelete.mockResolvedValueOnce(false);
      dialogs.askNewFileName.mockResolvedValueOnce(undefined);
      const before = sent().length;

      panel()!.command.emit({ command: 'rename', docId: 'file-1' });
      panel()!.command.emit({ command: 'delete', docId: 'file-1' });
      panel()!.command.emit({ command: 'create-file' });
      await settle();

      expect(sent()).toHaveLength(before);
    });
  });
});
