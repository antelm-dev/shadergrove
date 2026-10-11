import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CompileDiagnostic } from '@shadergrove/shared/diagnostic';
import { EditorNavigation } from '../editor/editor-navigation';
import { SurfaceLayoutService } from '../surfaces/surface-layout';
import { OutputLog } from '../ui/bottom-panel/output-log';
import {
  BOTTOM_PANEL_CHANNEL,
  BottomPanelHost,
  BottomPanelMirror,
  MAX_MIRRORED,
  type BottomPanelMessage,
} from './bottom-panel-sync';
import { ShaderStore } from './shader-store';
import { FakeBroadcastChannel } from './testing/fake-broadcast-channel';

const diagnostic = (line: number, severity: CompileDiagnostic['severity'] = 'error') =>
  ({
    severity,
    line,
    message: `problem ${line}`,
    source: 'fragment',
    docId: 'image',
  }) satisfies CompileDiagnostic;

/** The other end of the channel, as the test sees it. */
function peer(): { channel: FakeBroadcastChannel; received: BottomPanelMessage[] } {
  const channel = new FakeBroadcastChannel(BOTTOM_PANEL_CHANNEL);
  const received: BottomPanelMessage[] = [];
  channel.onmessage = ({ data }) => received.push(data as BottomPanelMessage);
  return { channel, received };
}

const snapshots = (messages: BottomPanelMessage[]) =>
  messages.filter((message) => message.kind === 'snapshot');

describe('BottomPanelHost (main window)', () => {
  const diagnostics = signal<readonly CompileDiagnostic[]>([]);
  const native = signal(false);
  const openEditor = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    diagnostics.set([]);
    native.set(false);
    openEditor.mockReset();
    TestBed.configureTestingModule({
      providers: [
        { provide: ShaderStore, useValue: { allDiagnostics: diagnostics } },
        { provide: SurfaceLayoutService, useValue: { bottomPanelNative: native, openEditor } },
      ],
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    FakeBroadcastChannel.reset();
    vi.unstubAllGlobals();
  });

  const start = () => {
    const host = TestBed.inject(BottomPanelHost);
    host.start();
    TestBed.tick();
    return host;
  };

  it("answers a starting satellite with the session's diagnostics and output", () => {
    TestBed.inject(OutputLog).info('compiler', 'compiled');
    diagnostics.set([diagnostic(3)]);
    start();
    const satellite = peer();

    satellite.channel.postMessage({ kind: 'ready' } satisfies BottomPanelMessage);

    expect(satellite.received).toEqual([
      {
        kind: 'snapshot',
        diagnostics: [diagnostic(3)],
        entries: [expect.objectContaining({ level: 'info', message: 'compiled' })],
      },
    ]);
  });

  it('publishes live changes only while a native window shows the panel', () => {
    const log = TestBed.inject(OutputLog);
    const satellite = peer();
    start();

    log.info('compiler', 'docked');
    TestBed.tick();
    expect(satellite.received).toEqual([]);

    native.set(true);
    TestBed.tick();
    log.error('renderer', 'lost context');
    diagnostics.set([diagnostic(7)]);
    TestBed.tick();

    const last = snapshots(satellite.received).at(-1);
    expect(last?.kind === 'snapshot' && last.entries.map((entry) => entry.message)).toEqual([
      'docked',
      'lost context',
    ]);
    expect(last?.kind === 'snapshot' && last.diagnostics).toEqual([diagnostic(7)]);
  });

  it('never sends more than the bounded snapshot', () => {
    diagnostics.set(Array.from({ length: MAX_MIRRORED + 100 }, (_, index) => diagnostic(index)));
    start();
    const satellite = peer();

    satellite.channel.postMessage({ kind: 'ready' } satisfies BottomPanelMessage);

    const [snapshot] = satellite.received;
    expect(snapshot.kind === 'snapshot' && snapshot.diagnostics.length).toBe(MAX_MIRRORED);
  });

  it("reveals a satellite's diagnostic in the main editor", () => {
    start();
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined);

    peer().channel.postMessage({
      kind: 'reveal',
      docId: 'common',
      line: 12,
    } satisfies BottomPanelMessage);

    expect(openEditor).toHaveBeenCalledOnce();
    expect(TestBed.inject(EditorNavigation).request()).toMatchObject({ docId: 'common', line: 12 });
    expect(focus).toHaveBeenCalled();
  });

  it('ignores a malformed reveal', () => {
    start();

    peer().channel.postMessage({ kind: 'reveal', docId: 'common', line: 'twelve' });
    peer().channel.postMessage({ kind: 'reveal', line: 3 });

    expect(openEditor).not.toHaveBeenCalled();
    expect(TestBed.inject(EditorNavigation).request()).toBeNull();
  });

  it("clears the main window's log when the satellite asks", () => {
    const log = TestBed.inject(OutputLog);
    log.info('compiler', 'compiled');
    start();

    peer().channel.postMessage({ kind: 'clear-output' } satisfies BottomPanelMessage);

    expect(log.entries()).toEqual([]);
  });

  it('suggests a tab to the satellite', () => {
    const host = start();
    const satellite = peer();

    host.show('problems');

    expect(satellite.received).toEqual([{ kind: 'show', tab: 'problems' }]);
  });

  it('closes its channel with the app', () => {
    start();
    expect(FakeBroadcastChannel.open.size).toBe(1);

    TestBed.resetTestingModule();

    expect(FakeBroadcastChannel.open.size).toBe(0);
  });

  it('does nothing where BroadcastChannel does not exist', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const host = start();

    expect(() => host.show('output')).not.toThrow();
  });
});

describe('BottomPanelMirror (native window)', () => {
  beforeEach(() => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    FakeBroadcastChannel.reset();
    vi.unstubAllGlobals();
  });

  it('asks the main window for a snapshot on start, then shows what arrives', () => {
    const main = peer();
    const mirror = TestBed.inject(BottomPanelMirror);

    mirror.start();
    expect(main.received).toEqual([{ kind: 'ready' }]);

    main.channel.postMessage({
      kind: 'snapshot',
      diagnostics: [diagnostic(1)],
      entries: [{ id: 4, timestamp: 0, level: 'warning', source: 'renderer', message: 'slow' }],
    } satisfies BottomPanelMessage);

    expect(mirror.diagnostics()).toEqual([diagnostic(1)]);
    expect(mirror.entries().map((entry) => entry.message)).toEqual(['slow']);
  });

  it('only sends intents: its own copy changes when the main window says so', () => {
    const main = peer();
    const mirror = TestBed.inject(BottomPanelMirror);
    mirror.start();
    main.channel.postMessage({
      kind: 'snapshot',
      diagnostics: [diagnostic(9)],
      entries: [{ id: 1, timestamp: 0, level: 'info', source: 'compiler', message: 'ok' }],
    } satisfies BottomPanelMessage);

    mirror.reveal(diagnostic(9));
    mirror.clearOutput();

    expect(main.received.slice(1)).toEqual([
      { kind: 'reveal', docId: 'image', line: 9 },
      { kind: 'clear-output' },
    ]);
    expect(mirror.entries()).toHaveLength(1);
  });

  it('takes a suggested tab and ignores anything malformed', () => {
    const main = peer();
    const mirror = TestBed.inject(BottomPanelMirror);
    mirror.start();

    main.channel.postMessage({ kind: 'show', tab: 'output' } satisfies BottomPanelMessage);
    main.channel.postMessage({ kind: 'show', tab: 'profiler' });
    main.channel.postMessage({ kind: 'snapshot', diagnostics: 'all of them', entries: [] });
    main.channel.postMessage(null);

    expect(mirror.tab()).toBe('output');
    expect(mirror.diagnostics()).toEqual([]);
  });

  it('closes its channel with the window', () => {
    TestBed.inject(BottomPanelMirror).start();
    expect(FakeBroadcastChannel.open.size).toBe(1);

    TestBed.resetTestingModule();

    expect(FakeBroadcastChannel.open.size).toBe(0);
  });

  it('stays empty where BroadcastChannel does not exist', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const mirror = TestBed.inject(BottomPanelMirror);

    mirror.start();
    mirror.reveal(diagnostic(1));

    expect(mirror.diagnostics()).toEqual([]);
  });
});

describe('BottomPanelHost and BottomPanelMirror together', () => {
  afterEach(() => {
    TestBed.resetTestingModule();
    FakeBroadcastChannel.reset();
    vi.unstubAllGlobals();
  });

  it("keeps the satellite on the main window's current output, live", () => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    const diagnostics = signal<readonly CompileDiagnostic[]>([diagnostic(2, 'warning')]);
    TestBed.configureTestingModule({
      providers: [
        { provide: ShaderStore, useValue: { allDiagnostics: diagnostics } },
        {
          provide: SurfaceLayoutService,
          useValue: { bottomPanelNative: signal(true), openEditor: vi.fn() },
        },
      ],
    });
    const log = TestBed.inject(OutputLog);
    log.info('compiler', 'first');
    TestBed.inject(BottomPanelHost).start();
    const mirror = TestBed.inject(BottomPanelMirror);

    mirror.start();
    expect(mirror.diagnostics()).toEqual([diagnostic(2, 'warning')]);
    expect(mirror.entries().map((entry) => entry.message)).toEqual(['first']);

    log.error('compiler', 'second');
    diagnostics.set([]);
    TestBed.tick();

    expect(mirror.entries().map((entry) => entry.message)).toEqual(['first', 'second']);
    expect(mirror.diagnostics()).toEqual([]);
  });
});
