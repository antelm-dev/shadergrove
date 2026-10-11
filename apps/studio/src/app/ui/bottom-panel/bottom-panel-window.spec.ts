import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CompileDiagnostic } from '@shadergrove/shared/diagnostic';
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
import { forbidMainWindowOnly } from '../../workspace/testing/main-window-only';
import { IDLE_PROFILER } from '../inspector/profiler-session';
import { BottomPanelWindow } from './bottom-panel-window';

const diagnostic: CompileDiagnostic = {
  severity: 'error',
  line: 4,
  message: 'undeclared identifier',
  source: 'fragment',
  docId: 'image',
  docName: 'Image',
};

describe('BottomPanelWindow (the bottom panel in its own window)', () => {
  const desktop = {
    available: true,
    returnSurface: vi.fn(async () => ({ status: 'returned', surfaceId: '' })),
    closeSurface: vi.fn(async () => ({ status: 'closed', surfaceId: '' })),
  };
  let main: FakeBroadcastChannel;
  let received: SessionMessage[];

  beforeEach(() => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
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
        ...forbidMainWindowOnly('bottom-panel'),
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
    message: SessionMessage,
  ) => {
    main.postMessage(message);
    await fixture.whenStable();
  };

  const lastCommand = () => {
    const message = received.at(-1);
    return message?.kind === 'command' ? message.command : null;
  };

  it('offers every tab of the docked panel, without the workspace session, and says hello', async () => {
    const { root } = await mount();

    expect(received).toEqual([{ kind: 'hello', client: expect.any(String) }]);
    expect(
      [...root.querySelectorAll('[role="tab"] > span:first-of-type')].map((label) =>
        label.textContent?.trim(),
      ),
    ).toEqual(['Problems', 'Output', 'Profiler', 'Inspection']);
    expect(root.querySelector('app-problems-panel')).not.toBeNull();
    expect(root.querySelector('app-output-panel')).not.toBeNull();
    expect(root.querySelector('app-profiler-view')).not.toBeNull();
    expect(root.querySelector('app-preview-shell, app-editor-shell, mat-toolbar')).toBeNull();
  });

  it("shows the main window's diagnostics and output as they arrive", async () => {
    const { fixture, root } = await mount();
    expect(root.textContent).toContain('No problems detected.');

    await publish(fixture, {
      kind: 'state',
      patch: {
        diagnostics: [diagnostic],
        entries: [{ id: 1, timestamp: 0, level: 'error', source: 'compiler', message: 'failed' }],
      },
    });

    expect(root.querySelector('.row')?.textContent).toContain('undeclared identifier');
    expect(root.querySelector('.count.error')?.textContent?.trim()).toBe('1');
    expect(root.querySelector('.entry .message')?.textContent).toBe('failed');

    await publish(fixture, { kind: 'state', patch: { diagnostics: [] } });
    expect(root.querySelector('.row')).toBeNull();
  });

  it('shows the tab the main window has selected, and selects tabs there', async () => {
    const { fixture, root } = await mount();
    const panel = (name: string) => root.querySelector<HTMLElement>(`#bottom-panel-panel-${name}`)!;

    await publish(fixture, { kind: 'state', patch: { bottomPanelTab: 'profiler' } });
    expect(panel('profiler').hidden).toBe(false);
    expect(panel('problems').hidden).toBe(true);

    root.querySelector<HTMLButtonElement>('#bottom-panel-tab-output')!.click();
    await fixture.whenStable();
    expect(lastCommand()).toEqual({ kind: 'bottom-panel-tab', tab: 'output' });
    expect(panel('output').hidden).toBe(false);
  });

  it("mirrors the main window's profiler and asks it to apply a suggestion", async () => {
    const { fixture, root } = await mount();
    await publish(fixture, {
      kind: 'state',
      patch: {
        bottomPanelTab: 'profiler',
        profiler: {
          ...IDLE_PROFILER,
          suggestion: 0.75,
          status: { kind: 'suggestion', scale: 0.75 },
        },
      },
    });
    // No snapshot yet: the empty state, as in the docked panel.
    expect(root.querySelector('#bottom-panel-panel-profiler')?.textContent).toContain(
      'Waiting for the active preview',
    );

    await publish(fixture, {
      kind: 'state',
      patch: {
        profiler: {
          snapshot: {
            enabled: true,
            gpuSupport: 'supported',
            sampleCount: 40,
            lastSampleAgeMs: 10,
            cpuSubmission: { medianMs: 1, p95Ms: 1 },
            totalGpu: { medianMs: 30, p95Ms: 32 },
            passes: [],
            renderTargetBytes: 0,
            textureBytes: 0,
            textureEstimated: true,
            textures: [],
            compiles: [],
          },
          suggestion: 0.75,
          status: { kind: 'suggestion', scale: 0.75 },
        },
      },
    });
    root.querySelector<HTMLButtonElement>('.suggestion button')!.click();

    expect(lastCommand()).toEqual({ kind: 'apply-profiler-suggestion', scale: 0.75 });
  });

  it('explains that frame inspection needs the main window, and docks on request', async () => {
    const { fixture, root } = await mount();
    await publish(fixture, { kind: 'state', patch: { bottomPanelTab: 'inspection' } });

    const inspection = root.querySelector<HTMLElement>('#bottom-panel-panel-inspection')!;
    expect(inspection.textContent).toContain('captures the preview in the main window');
    inspection.querySelector<HTMLButtonElement>('button.dock-to-inspect')!.click();

    expect(desktop.returnSurface).toHaveBeenCalledWith(WELL_KNOWN_SURFACE_IDS.bottomPanel);
  });

  it('asks the main window to reveal a clicked diagnostic and to clear its log', async () => {
    const { fixture, root } = await mount();
    await publish(fixture, {
      kind: 'state',
      patch: {
        diagnostics: [diagnostic],
        entries: [{ id: 1, timestamp: 0, level: 'info', source: 'compiler', message: 'ok' }],
      },
    });

    root.querySelector<HTMLButtonElement>('.row')!.click();
    expect(lastCommand()).toEqual({ kind: 'reveal', docId: 'image', line: 4 });

    root.querySelector<HTMLButtonElement>('button[aria-label="Clear output"]')!.click();
    await fixture.whenStable();
    expect(lastCommand()).toEqual({ kind: 'clear-output' });
    // The copy empties only when the main window's log does.
    expect(root.querySelectorAll('.entry')).toHaveLength(1);
  });

  it('docks back and closes through the satellite surface IPC', async () => {
    const { root } = await mount();
    const id = WELL_KNOWN_SURFACE_IDS.bottomPanel;

    const dock = root.querySelector<HTMLButtonElement>('button.dock')!;
    const close = root.querySelector<HTMLButtonElement>('button.close')!;
    expect(dock.getAttribute('aria-label')).toBe('Dock in main window');
    expect(close.getAttribute('aria-label')).toBe('Close panel');

    dock.click();
    expect(desktop.returnSurface).toHaveBeenCalledWith(id);
    close.click();
    expect(desktop.closeSurface).toHaveBeenCalledWith(id);
  });
});
