import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_RENDER } from '@shadergrove/shared/model';
import { WELL_KNOWN_SURFACE_IDS } from '@shadergrove/shared/surfaces';
import { DesktopPlatform } from '../../desktop/desktop-platform';
import { I18n } from '../../i18n/i18n';
import { provideTestLanguages, speaking } from '../../i18n/testing/languages';
import { Preferences } from '../../prefs/preferences';
import {
  SESSION_CHANNEL,
  type SessionMessage,
} from '../../workspace/session-sync/session-protocol';
import { FakeBroadcastChannel } from '../../workspace/testing/fake-broadcast-channel';
import { FAKE_CONTROLS } from '../../workspace/testing/fake-session';
import { forbidMainWindowOnly } from '../../workspace/testing/main-window-only';
import { PresetDialogs } from '../dialogs/preset-dialogs';
import { InspectorSession } from './inspector-session';
import { INSPECTOR_WINDOW_PROVIDERS, InspectorWindow } from './inspector-window';

describe('InspectorWindow (the inspector in its own window)', () => {
  const desktop = {
    available: true,
    returnSurface: vi.fn(async () => ({ status: 'returned', surfaceId: '' })),
    closeSurface: vi.fn(async () => ({ status: 'closed', surfaceId: '' })),
    readTexture: vi.fn(async () => null),
  };
  const dialogs = {
    askToSave: vi.fn(async () => ({ name: 'Calm', withRender: false })),
    confirmDelete: vi.fn(async () => true),
  };
  let main: FakeBroadcastChannel;
  let received: SessionMessage[];

  beforeEach(() => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    // lil-gui asks for it; the test DOM has none.
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
    }));
    desktop.returnSurface.mockClear();
    desktop.closeSurface.mockClear();
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
        { provide: PresetDialogs, useValue: dialogs },
        ...forbidMainWindowOnly('inspector'),
        ...INSPECTOR_WINDOW_PROVIDERS,
      ],
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    FakeBroadcastChannel.reset();
    vi.unstubAllGlobals();
  });

  const mount = async () => {
    const fixture = TestBed.createComponent(InspectorWindow);
    await fixture.whenStable();
    main.postMessage({
      kind: 'state',
      patch: {
        shader: { id: 'waves', updatedAt: 'v1' },
        controls: FAKE_CONTROLS,
        params: { speed: 1, glow: false },
        render: DEFAULT_RENDER,
        presets: [{ id: 'p1', name: 'Calm', values: { speed: 2 }, createdAt: 'then' }],
      },
    } satisfies SessionMessage);
    await fixture.whenStable();
    return { fixture, root: fixture.nativeElement as HTMLElement };
  };

  const commands = () =>
    received.flatMap((message) => (message.kind === 'command' ? [message.command] : []));

  it('shows the same inspector on the mirrored session, without a session of its own', async () => {
    const { root } = await mount();

    expect(received[0]).toEqual({
      kind: 'hello',
      client: expect.any(String),
      window: 'inspector',
    });
    expect(root.querySelector('app-inspector-panel')).not.toBeNull();
    expect(root.querySelector('app-gui-panel .edit-controls')).not.toBeNull();
    // The controls tab counts the main window's controls.
    expect(root.querySelector('#inspector-tab-controls .badge')?.textContent?.trim()).toBe('2');
    expect(TestBed.inject(InspectorSession)).toBeInstanceOf(
      (await import('./remote-inspector-session')).RemoteInspectorSession,
    );
  });

  it("selects tabs in the main window's layout, showing the new one at once", async () => {
    const { fixture, root } = await mount();

    root.querySelector<HTMLButtonElement>('#inspector-tab-presets')!.click();
    await fixture.whenStable();

    expect(commands().at(-1)).toEqual({ kind: 'inspector-tab', tab: 'presets' });
    expect(root.querySelector<HTMLElement>('#inspector-panel-presets')!.hidden).toBe(false);
  });

  it('asks the main window for every change, and asks questions here', async () => {
    const { fixture } = await mount();
    const session = TestBed.inject(InspectorSession);

    session.setParam('speed', 4);
    expect(session.params()).toEqual({ speed: 4, glow: false });
    session.resetParams();
    void session.savePreset();
    await fixture.whenStable();
    void session.deletePreset('p1', 'Calm');
    await fixture.whenStable();
    session.editControls();
    void session.captureImage();

    expect(commands()).toEqual([
      { kind: 'set-param', key: 'speed', value: 4 },
      { kind: 'reset-params' },
      { kind: 'save-preset', name: 'Calm', withRender: false },
      { kind: 'delete-preset', presetId: 'p1' },
      { kind: 'edit-controls' },
      { kind: 'capture-image' },
    ]);
    expect(dialogs.confirmDelete).toHaveBeenCalledWith('Calm');
  });

  it('collapses by closing its window, and docks and closes through the surface IPC', async () => {
    const { root } = await mount();
    const id = WELL_KNOWN_SURFACE_IDS.inspector;

    root.querySelector<HTMLButtonElement>('button.collapse')!.click();
    expect(desktop.closeSurface).toHaveBeenLastCalledWith(id);

    const dock = root.querySelector<HTMLButtonElement>('app-satellite-controls button.dock')!;
    expect(dock.getAttribute('aria-label')).toBe('Dock in main window');
    dock.click();
    expect(desktop.returnSurface).toHaveBeenCalledWith(id);

    root.querySelector<HTMLButtonElement>('app-satellite-controls button.close')!.click();
    expect(desktop.closeSurface).toHaveBeenCalledTimes(2);
  });
});
