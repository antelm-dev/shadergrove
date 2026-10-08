import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';

import type { SyncRemoveResult } from '../../desktop/contracts/contracts';
import { DEFAULT_CHANNELS, DEFAULT_RENDER, type ShaderRecord } from '@shadergrove/shared/model';
import { migrateLegacyProject } from '@shadergrove/shared/project';
import { ApiError, ShaderApi } from '../api/shader-api';
import { AuthService } from '../auth/auth.service';
import { DesktopAccount } from '../desktop/desktop-account';
import { DesktopPlatform } from '../desktop/desktop-platform';
import { DesktopSync } from '../desktop/desktop-sync';
import { DesktopUpdater } from '../desktop/desktop-updater';
import { I18n } from '../i18n/i18n';
import {
  Preferences,
  createDefaultWorkspacePreferences,
  type WorkspacePreferences,
} from '../prefs/preferences';
import { ShaderStore } from '../workspace/shader-store';
import { ConfirmDialog } from './dialogs/confirm-dialog';
import { DeleteLinkedDialog } from './dialogs/delete-linked-dialog';
import { OpenDocuments } from './editor/open-documents';
import { WorkspaceActions } from './workspace-actions';

const FRAGMENT = 'void main() { gl_FragColor = vec4(1.0); }';
const VERTEX = 'void main() { gl_Position = vec4(position, 1.0); }';

function makeRecord(): ShaderRecord {
  return {
    id: 'waves',
    kind: 'shader',
    name: 'Waves',
    description: '',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    revision: 1,
    controls: [{ key: 'speed', type: 'number', default: 1, min: 0, max: 10 }],
    render: structuredClone(DEFAULT_RENDER),
    channels: structuredClone(DEFAULT_CHANNELS),
    thumbnail: null,
    fragment: FRAGMENT,
    vertex: VERTEX,
    presets: [],
    project: migrateLegacyProject(FRAGMENT, VERTEX),
  };
}

class FakeApi implements Partial<ShaderApi> {
  private readonly record = makeRecord();

  list = () =>
    Promise.resolve([
      {
        id: this.record.id,
        kind: this.record.kind,
        name: this.record.name,
        description: this.record.description,
        revision: this.record.revision,
        controlCount: this.record.controls.length,
        presetCount: 0,
        thumbnail: null,
        updatedAt: this.record.updatedAt,
      },
    ]);

  read = () => Promise.resolve(structuredClone(this.record));
}

class FakePreferences implements Partial<Preferences> {
  private readonly state = signal<WorkspacePreferences>(createDefaultWorkspacePreferences());

  readonly value = this.state.asReadonly();

  patch(patch: Partial<WorkspacePreferences>): void {
    this.state.update((current) => ({ ...current, ...patch }));
  }
}

describe('WorkspaceActions explorer adapters', () => {
  let actions: WorkspaceActions;
  let store: ShaderStore;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    TestBed.configureTestingModule({
      providers: [
        WorkspaceActions,
        ShaderStore,
        { provide: ShaderApi, useValue: new FakeApi() },
        { provide: Preferences, useValue: new FakePreferences() },
        { provide: DesktopPlatform, useValue: { available: false } },
        {
          provide: DesktopUpdater,
          useValue: {
            check: vi.fn(),
            state: signal({ status: 'unavailable', currentVersion: '' }),
          },
        },
        {
          provide: I18n,
          useValue: { locale: () => 'en', t: (key: string) => key },
        },
        {
          provide: MatDialog,
          useValue: {
            open: () => ({ afterClosed: () => of(undefined) }),
            getDialogById: () => undefined,
          },
        },
      ],
    });

    store = TestBed.inject(ShaderStore);
    actions = TestBed.inject(WorkspaceActions);
    await store.initialize();
  });

  it('selectDocument activates a document tab', () => {
    actions.selectDocument('@vertex');
    expect(store.activeDoc()?.id).toBe('@vertex');
  });

  it('reorderExplorer moves a source file within the file list', () => {
    store.addSourceFile('a.glsl');
    store.addSourceFile('b.glsl');
    const files = store.project()!.files;
    actions.reorderExplorer({
      sourceDocId: files[1].id,
      targetDocId: files[0].id,
      list: 'file',
    });
    expect(store.project()!.files.map((file) => file.name)).toEqual(['b.glsl', 'a.glsl']);
  });

  it('reorderExplorer moves a buffer within the buffer list', async () => {
    store.addBufferPass();
    store.addBufferPass();
    const buffers = store.buffers();
    actions.reorderExplorer({
      sourceDocId: buffers[1].id,
      targetDocId: buffers[0].id,
      list: 'buffer',
    });
    expect(store.buffers().map((pass) => pass.id)).toEqual([buffers[1].id, buffers[0].id]);
  });

  it('duplicateDocument copies a source file', () => {
    store.addSourceFile('lib.glsl');
    const file = store.documents().find((doc) => doc.kind === 'file');
    expect(file).toBeDefined();
    actions.duplicateDocument(file!);
    expect(store.project()!.files.length).toBe(2);
  });
});

describe('WorkspaceActions Help flows', () => {
  const check = vi.fn(async () => undefined);
  const open = vi.fn();
  const getDialogById = vi.fn((_id?: string) => undefined as { id: string } | undefined);
  let actions: WorkspaceActions;

  beforeEach(() => {
    TestBed.resetTestingModule();
    check.mockReset();
    open.mockReset();
    getDialogById.mockReset();
    getDialogById.mockReturnValue(undefined);

    TestBed.configureTestingModule({
      providers: [
        WorkspaceActions,
        { provide: ShaderStore, useValue: {} },
        { provide: Preferences, useValue: new FakePreferences() },
        { provide: DesktopPlatform, useValue: { available: true } },
        {
          provide: DesktopUpdater,
          useValue: { check, state: signal({ status: 'idle', currentVersion: '1.0.0' }) },
        },
        {
          provide: I18n,
          useValue: { locale: () => 'en', t: (key: string) => key },
        },
        {
          provide: MatDialog,
          useValue: { open, getDialogById },
        },
        { provide: ShaderApi, useValue: new FakeApi() },
        { provide: OpenDocuments, useValue: { openIds: () => [], activate: () => undefined } },
      ],
    });

    actions = TestBed.inject(WorkspaceActions);
  });

  it('openKeyboardShortcuts dynamically opens the shortcuts dialog once', async () => {
    await actions.openKeyboardShortcuts();
    expect(open).toHaveBeenCalledOnce();
    const [component, config] = open.mock.calls[0]!;
    expect(String(component.name)).toContain('KeyboardShortcutsDialog');
    expect(config).toMatchObject({ id: 'keyboard-shortcuts', width: '520px' });

    getDialogById.mockReturnValue({ id: 'keyboard-shortcuts' });
    await actions.openKeyboardShortcuts();
    expect(open).toHaveBeenCalledOnce();
  });

  it('openAboutShadergrove opens About without checking for updates', async () => {
    await actions.openAboutShadergrove();
    expect(check).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledOnce();
    const [component, config] = open.mock.calls[0]!;
    expect(String(component.name)).toMatch(/DesktopVersionDialog|AboutShadergroveDialog/);
    expect(config).toMatchObject({ id: 'about-shader-studio', width: '480px' });
  });

  it('checkForUpdates forces a check then opens About without stacking', async () => {
    await actions.checkForUpdates();
    expect(check).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledOnce();

    getDialogById.mockImplementation((id?: string) =>
      id === 'about-shader-studio' ? { id } : undefined,
    );
    await actions.checkForUpdates();
    expect(check).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledOnce();
  });

  it('checkForUpdates propagates updater errors without opening a dialog', async () => {
    check.mockRejectedValueOnce(new Error('network down'));
    await expect(actions.checkForUpdates()).rejects.toThrow('network down');
    expect(open).not.toHaveBeenCalled();
  });
});

describe('WorkspaceActions.signOut', () => {
  const auth = { signOut: vi.fn(async () => ({ ok: true })) };
  let choice: string | undefined;
  let actions: WorkspaceActions;
  let store: ShaderStore;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        { provide: ShaderApi, useValue: new FakeApi() },
        { provide: Preferences, useValue: new FakePreferences() },
        { provide: AuthService, useValue: auth },
        { provide: DesktopPlatform, useValue: { available: false } },
        {
          provide: I18n,
          useValue: { locale: () => 'en', t: (key: string) => key },
        },
        {
          provide: MatDialog,
          useValue: { open: () => ({ afterClosed: () => of(choice) }) },
        },
      ],
    });
    store = TestBed.inject(ShaderStore);
    actions = TestBed.inject(WorkspaceActions);
    await store.initialize();
    store.setFragment('void main() {}');
  });

  it('keeps the session and the draft when the user cancels', async () => {
    choice = 'cancel';
    expect(await actions.signOut()).toBeNull();
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(store.dirty()).toBe(true);
  });

  it('closes the library once the server has signed out', async () => {
    choice = 'discard';
    expect(await actions.signOut()).toEqual({ ok: true });
    expect(store.record()).toBeNull();
    expect(store.shaders()).toEqual([]);
  });

  it('leaves the library alone when signing out fails', async () => {
    choice = 'discard';
    auth.signOut.mockResolvedValueOnce({ ok: false } as never);
    await actions.signOut();
    expect(store.record()).not.toBeNull();
    expect(store.shaders()).toHaveLength(1);
  });
});

describe('WorkspaceActions.deleteShader', () => {
  const sync = {
    isLinked: vi.fn(() => false),
    remove: vi.fn(async (): Promise<SyncRemoveResult> => 'ok'),
  };
  const api = Object.assign(new FakeApi(), { remove: vi.fn(async () => undefined) });
  let choices: unknown[];
  let opened: unknown[];
  let actions: WorkspaceActions;
  let store: ShaderStore;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    vi.clearAllMocks();
    opened = [];
    TestBed.configureTestingModule({
      providers: [
        { provide: ShaderApi, useValue: api },
        { provide: Preferences, useValue: new FakePreferences() },
        { provide: DesktopPlatform, useValue: { available: false } },
        { provide: DesktopSync, useValue: sync },
        {
          provide: DesktopAccount,
          useValue: { state: signal({ status: 'signed-in', user: { id: 'user-a' } }) },
        },
        {
          provide: I18n,
          useValue: { locale: () => 'en', t: (key: string) => key },
        },
        {
          provide: MatDialog,
          useValue: {
            open: (component: unknown) => {
              opened.push(component);
              return { afterClosed: () => of(choices.shift()) };
            },
          },
        },
      ],
    });
    actions = TestBed.inject(WorkspaceActions);
    store = TestBed.inject(ShaderStore);
    await store.initialize();
  });

  it.each(['local', 'everywhere'])(
    'routes "%s" on a linked shader to sync.remove, bound to the account and revision',
    async (mode) => {
      sync.isLinked.mockReturnValue(true);
      choices = [mode];

      await actions.deleteShader('waves', 'Waves');

      expect(opened).toEqual([DeleteLinkedDialog]);
      expect(sync.remove).toHaveBeenCalledWith({
        id: 'waves',
        mode,
        userId: 'user-a',
        revision: 1,
      });
      expect(api.remove).not.toHaveBeenCalled();
    },
  );

  it('deletes nothing when the linked dialog is cancelled', async () => {
    sync.isLinked.mockReturnValue(true);
    choices = [undefined];

    await actions.deleteShader('waves', 'Waves');

    expect(sync.remove).not.toHaveBeenCalled();
    expect(api.remove).not.toHaveBeenCalled();
  });

  it('falls back to the plain confirm, then a plain delete, when not linked after all', async () => {
    sync.isLinked.mockReturnValue(true);
    sync.remove.mockResolvedValueOnce('not-linked');
    choices = ['everywhere', true];

    await actions.deleteShader('waves', 'Waves');

    expect(opened).toEqual([DeleteLinkedDialog, ConfirmDialog]);
    expect(api.remove).toHaveBeenCalledWith('waves');
  });

  it.each(['changed', 'account-changed'] as const)(
    'deletes nothing and tells the user when sync answers %s',
    async (result) => {
      sync.isLinked.mockReturnValue(true);
      sync.remove.mockResolvedValueOnce(result);
      choices = ['everywhere'];

      await actions.deleteShader('waves', 'Waves');

      expect(opened).toEqual([DeleteLinkedDialog]);
      expect(api.remove).not.toHaveBeenCalled();
      expect(store.shaders()).toHaveLength(1);
      expect(store.notice()?.text).toBe(
        result === 'changed' ? 'sync.deleteChanged' : 'sync.deleteAccountChanged',
      );
    },
  );

  it('keeps the plain confirm dialog for an unlinked shader', async () => {
    sync.isLinked.mockReturnValue(false);
    choices = [true];

    await actions.deleteShader('waves', 'Waves');

    expect(opened).toEqual([ConfirmDialog]);
    expect(sync.remove).not.toHaveBeenCalled();
    expect(api.remove).toHaveBeenCalledWith('waves');
  });
});

describe('WorkspaceActions history', () => {
  const RESTORED = 'void main() { gl_FragColor = vec4(0.25); }';
  const api = Object.assign(new FakeApi(), {
    restoreHistory: vi.fn(
      async (_id: string, _revision: number, expectedRevision: number): Promise<ShaderRecord> => ({
        ...makeRecord(),
        revision: expectedRevision + 1,
        updatedAt: '2024-04-04T00:00:00.000Z',
        fragment: RESTORED,
        project: migrateLegacyProject(RESTORED, VERTEX),
      }),
    ),
  });
  let choices: unknown[];
  let opened: { component: unknown; config: unknown }[];
  let actions: WorkspaceActions;
  let store: ShaderStore;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    vi.clearAllMocks();
    choices = [];
    opened = [];
    TestBed.configureTestingModule({
      providers: [
        { provide: ShaderApi, useValue: api },
        { provide: Preferences, useValue: new FakePreferences() },
        { provide: DesktopPlatform, useValue: { available: false } },
        {
          provide: I18n,
          useValue: {
            locale: () => 'en',
            t: (key: string, params?: Record<string, unknown>) =>
              params ? `${key} ${JSON.stringify(params)}` : key,
          },
        },
        {
          provide: MatDialog,
          useValue: {
            open: (component: unknown, config: unknown) => {
              opened.push({ component, config });
              return { afterClosed: () => of(choices.shift()) };
            },
            getDialogById: (id: string) =>
              opened.some(({ config }) => (config as { id?: string })?.id === id) ? {} : undefined,
          },
        },
      ],
    });
    actions = TestBed.inject(WorkspaceActions);
    store = TestBed.inject(ShaderStore);
    await store.initialize();
  });

  it('opens History over a dirty draft without asking, once', async () => {
    store.setFragment('void main() {}');

    await actions.openHistory();
    await actions.openHistory();

    expect(opened).toHaveLength(1);
    expect(String((opened[0].component as { name: string }).name)).toContain('HistoryDialog');
    expect(opened[0].config).toMatchObject({ data: { shaderId: 'waves', name: 'Waves' } });
    expect(store.dirty()).toBe(true);
  });

  it('keeps the draft and writes nothing when the guard is cancelled', async () => {
    store.setFragment('void main() {}');
    choices = ['cancel'];

    expect(await actions.restoreHistory('waves', 1)).toBe('cancelled');

    expect(api.restoreHistory).not.toHaveBeenCalled();
    expect(store.fragment()).toBe('void main() {}');
    expect(store.dirty()).toBe(true);
  });

  it('discards, then restores as a clean new head and says so', async () => {
    store.setFragment('void main() {}');
    choices = ['discard'];

    expect(await actions.restoreHistory('waves', 1)).toBe('restored');

    expect(api.restoreHistory).toHaveBeenCalledWith('waves', 1, 1);
    expect(store.fragment()).toBe(RESTORED);
    expect(store.record()?.revision).toBe(2);
    expect(store.dirty()).toBe(false);
    expect(store.notice()).toEqual({ text: 'history.restored {"revision":1}', error: false });
  });

  it('restores a clean document without asking', async () => {
    expect(await actions.restoreHistory('waves', 1)).toBe('restored');
    expect(opened).toHaveLength(0);
  });

  it('tells the user about a stale head and keeps the document', async () => {
    api.restoreHistory.mockRejectedValueOnce(new ApiError('modified by another write', [], 409));

    expect(await actions.restoreHistory('waves', 1)).toBe('conflict');

    expect(store.fragment()).toBe(FRAGMENT);
    expect(store.notice()).toEqual({ text: 'history.conflict', error: true });
  });
});
