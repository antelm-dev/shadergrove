import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
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
import { FAKE_DOCUMENTS } from '../../workspace/testing/fake-session';
import { forbidMainWindowOnly } from '../../workspace/testing/main-window-only';
import { EditorWindow } from './editor-window';

const IMAGE = 'void main() {}';

describe('EditorWindow (the editor in its own window)', () => {
  const desktop = {
    available: true,
    returnSurface: vi.fn(async () => ({ status: 'returned', surfaceId: '' })),
    closeSurface: vi.fn(async () => ({ status: 'closed', surfaceId: '' })),
  };
  let main: FakeBroadcastChannel;
  let received: SessionMessage[];
  let fixture: ComponentFixture<EditorWindow>;

  beforeEach(async () => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    models.length = 0;
    editors.length = 0;
    desktop.returnSurface.mockClear();
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
          useValue: { value: signal(speaking('en')).asReadonly(), patch: () => undefined },
        },
        { provide: DesktopPlatform, useValue: desktop },
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
    expect(received[0]).toEqual({ kind: 'hello', client: expect.any(String) });
    expect(
      [...root().querySelectorAll('[role="tab"] .name')].map((tab) => tab.textContent),
    ).toEqual(['Image', 'Config']);

    type(image(), ' // a');

    expect(commands().at(-1)?.command).toEqual({
      kind: 'edit',
      shaderId: 'waves',
      docId: 'image',
      source: `${IMAGE} // a`,
    });
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
});
