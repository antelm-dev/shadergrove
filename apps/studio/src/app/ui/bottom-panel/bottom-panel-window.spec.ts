import { provideZonelessChangeDetection, signal, type Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CompileDiagnostic } from '@shadergrove/shared/diagnostic';
import { WELL_KNOWN_SURFACE_IDS } from '@shadergrove/shared/surfaces';
import { DesktopPlatform } from '../../desktop/desktop-platform';
import { I18n } from '../../i18n/i18n';
import { provideTestLanguages, speaking } from '../../i18n/testing/languages';
import { Preferences } from '../../prefs/preferences';
import { SurfaceLayoutService } from '../../surfaces/surface-layout';
import {
  BOTTOM_PANEL_CHANNEL,
  BottomPanelHost,
  type BottomPanelMessage,
} from '../../workspace/bottom-panel-sync';
import { OutputSync } from '../../workspace/output-sync';
import { RoutingCoordinator } from '../../workspace/routing-coordinator';
import { ShaderStore } from '../../workspace/shader-store';
import { StartupCoordinator } from '../../workspace/startup-coordinator';
import { FakeBroadcastChannel } from '../../workspace/testing/fake-broadcast-channel';
import { BottomPanelWindow } from './bottom-panel-window';

/** What the native window must never create: the main window's session and its side effects. */
const MAIN_WINDOW_ONLY: readonly Type<unknown>[] = [
  ShaderStore,
  StartupCoordinator,
  RoutingCoordinator,
  OutputSync,
  SurfaceLayoutService,
  BottomPanelHost,
];

const diagnostic: CompileDiagnostic = {
  severity: 'error',
  line: 4,
  message: 'undeclared identifier',
  source: 'fragment',
  docId: 'image',
  docName: 'Image',
};

describe('BottomPanelWindow (native Problems/Output window)', () => {
  const desktop = {
    available: true,
    returnSurface: vi.fn(async () => ({ status: 'returned', surfaceId: '' })),
    closeSurface: vi.fn(async () => ({ status: 'closed', surfaceId: '' })),
  };
  let main: FakeBroadcastChannel;
  let received: BottomPanelMessage[];

  beforeEach(() => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    desktop.returnSurface.mockClear();
    desktop.closeSurface.mockClear();
    main = new FakeBroadcastChannel(BOTTOM_PANEL_CHANNEL);
    received = [];
    main.onmessage = ({ data }) => received.push(data as BottomPanelMessage);

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
        ...MAIN_WINDOW_ONLY.map((token) => ({
          provide: token,
          useFactory: () => {
            throw new Error(`the bottom-panel window must not create ${token.name}`);
          },
        })),
      ],
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    FakeBroadcastChannel.reset();
    vi.unstubAllGlobals();
  });

  const mount = async () => {
    const fixture = TestBed.createComponent(BottomPanelWindow);
    await fixture.whenStable();
    return { fixture, root: fixture.nativeElement as HTMLElement };
  };

  const publish = async (
    fixture: Awaited<ReturnType<typeof mount>>['fixture'],
    message: BottomPanelMessage,
  ) => {
    main.postMessage(message);
    await fixture.whenStable();
  };

  it('renders only the panel shell, without the workspace session, and asks for a snapshot', async () => {
    const { root } = await mount();

    expect(received).toEqual([{ kind: 'ready' }]);
    expect(
      [...root.querySelectorAll('[role="tab"] > span')].map((label) => label.textContent?.trim()),
    ).toEqual(['Problems', 'Output']);
    expect(root.querySelector('app-problems-panel')).not.toBeNull();
    expect(root.querySelector('app-output-panel')).not.toBeNull();
    expect(root.querySelector('app-preview-shell, app-editor-shell, mat-toolbar')).toBeNull();
  });

  it("shows the main window's diagnostics and output as they arrive", async () => {
    const { fixture, root } = await mount();
    expect(root.textContent).toContain('No problems detected.');

    await publish(fixture, {
      kind: 'snapshot',
      diagnostics: [diagnostic],
      entries: [{ id: 1, timestamp: 0, level: 'error', source: 'compiler', message: 'failed' }],
    });

    expect(root.querySelector('.row')?.textContent).toContain('undeclared identifier');
    expect(root.querySelector('.count.error')?.textContent?.trim()).toBe('1');
    expect(root.querySelector('.entry .message')?.textContent).toBe('failed');

    await publish(fixture, {
      kind: 'snapshot',
      diagnostics: [],
      entries: [
        { id: 1, timestamp: 0, level: 'error', source: 'compiler', message: 'failed' },
        { id: 2, timestamp: 0, level: 'info', source: 'compiler', message: 'compiled' },
      ],
    });

    expect(root.querySelector('.row')).toBeNull();
    expect(root.querySelectorAll('.entry')).toHaveLength(2);
  });

  it('asks the main window to reveal a clicked diagnostic', async () => {
    const { fixture, root } = await mount();
    await publish(fixture, { kind: 'snapshot', diagnostics: [diagnostic], entries: [] });

    root.querySelector<HTMLButtonElement>('.row')!.click();

    expect(received.at(-1)).toEqual({ kind: 'reveal', docId: 'image', line: 4 });
  });

  it('asks the main window to clear its log rather than clearing a copy', async () => {
    const { fixture, root } = await mount();
    await publish(fixture, {
      kind: 'snapshot',
      diagnostics: [],
      entries: [{ id: 1, timestamp: 0, level: 'info', source: 'compiler', message: 'ok' }],
    });

    root.querySelector<HTMLButtonElement>('button[aria-label="Clear output"]')!.click();
    await fixture.whenStable();

    expect(received.at(-1)).toEqual({ kind: 'clear-output' });
    expect(root.querySelectorAll('.entry')).toHaveLength(1);
  });

  it('switches tabs locally and follows a tab the main window suggests', async () => {
    const { fixture, root } = await mount();
    const panel = (name: string) => root.querySelector<HTMLElement>(`#bottom-panel-panel-${name}`)!;
    expect(panel('output').hidden).toBe(true);

    root.querySelector<HTMLButtonElement>('#bottom-panel-tab-output')!.click();
    await fixture.whenStable();
    expect(panel('output').hidden).toBe(false);
    expect(panel('problems').hidden).toBe(true);

    await publish(fixture, { kind: 'show', tab: 'problems' });
    expect(panel('problems').hidden).toBe(false);
  });

  it('docks back and closes through the satellite surface IPC', async () => {
    const { root } = await mount();
    const id = WELL_KNOWN_SURFACE_IDS.bottomPanel;

    const dock = root.querySelector<HTMLButtonElement>('button.dock')!;
    const close = root.querySelector<HTMLButtonElement>('button.close')!;
    expect(dock.getAttribute('aria-label')).toBe('Dock to bottom');
    expect(close.getAttribute('aria-label')).toBe('Close panel');

    dock.click();
    expect(desktop.returnSurface).toHaveBeenCalledWith(id);
    close.click();
    expect(desktop.closeSurface).toHaveBeenCalledWith(id);
  });
});
