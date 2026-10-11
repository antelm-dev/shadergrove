import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CompileDiagnostic } from '@shadergrove/shared/diagnostic';
import { DEFAULT_RENDER } from '@shadergrove/shared/model';
import { validateRender } from '@shadergrove/shared/validate';
import { EditorNavigation } from '../../editor/editor-navigation';
import { OutputLog } from '../../ui/bottom-panel/output-log';
import { FakeBroadcastChannel } from '../testing/fake-broadcast-channel';
import { FakeMainSession } from '../testing/fake-session';
import { SessionHost } from './session-host';
import { SessionMirror } from './session-mirror';
import {
  EMPTY_SESSION,
  MAX_MIRRORED,
  SESSION_CHANNEL,
  SESSION_FIELDS,
  type SessionCommand,
  type SessionMessage,
  textFingerprint,
} from './session-protocol';

const IMAGE = 'void main() {}';

const diagnostic = (line: number): CompileDiagnostic => ({
  severity: 'error',
  line,
  message: `problem ${line}`,
  source: 'fragment',
  docId: 'image',
});

/** The other end of the channel, as the test sees it. */
function peer(): { channel: FakeBroadcastChannel; received: SessionMessage[] } {
  const channel = new FakeBroadcastChannel(SESSION_CHANNEL);
  const received: SessionMessage[] = [];
  channel.onmessage = ({ data }) => received.push(data as SessionMessage);
  return { channel, received };
}

const flushPromises = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('SessionHost (main window)', () => {
  let session: FakeMainSession;

  beforeEach(() => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    session = new FakeMainSession();
    TestBed.configureTestingModule({ providers: session.providers() });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    FakeBroadcastChannel.reset();
    vi.unstubAllGlobals();
  });

  const start = () => {
    const host = TestBed.inject(SessionHost);
    host.start();
    TestBed.tick();
    return host;
  };

  /** Sends a command as a panel window would, and waits for its answer. */
  const command = async (
    satellite: ReturnType<typeof peer>,
    command: SessionCommand,
    seq = 1,
  ): Promise<SessionMessage[]> => {
    const from = satellite.received.length;
    satellite.channel.postMessage({ kind: 'command', client: 'panel', seq, command });
    await flushPromises();
    return satellite.received.slice(from);
  };

  it('answers hello with every field, bounded', () => {
    session.allDiagnostics.set(
      Array.from({ length: MAX_MIRRORED + 10 }, (_, index) => diagnostic(index)),
    );
    start();
    const satellite = peer();

    satellite.channel.postMessage({ kind: 'hello', client: 'panel' });

    const [state] = satellite.received;
    expect(state.kind).toBe('state');
    if (state.kind !== 'state') return;
    expect(Object.keys(state.patch).sort()).toEqual([...SESSION_FIELDS].sort());
    expect(state.patch.diagnostics).toHaveLength(MAX_MIRRORED);
    expect(state.patch.documents).toEqual(session.documents());
    expect(state.patch.shader).toEqual({ id: 'waves', updatedAt: '2024-01-01T00:00:00.000Z' });
  });

  it('announces itself, then its session once a shader is loaded', () => {
    session.loading.set(true);
    const satellite = peer();
    start();
    expect(satellite.received).toEqual([{ kind: 'host', ready: false }]);

    session.loading.set(false);
    TestBed.tick();
    session.loading.set(true);
    session.loading.set(false);
    TestBed.tick();

    expect(satellite.received).toEqual([
      { kind: 'host', ready: false },
      { kind: 'host', ready: true },
    ]);
  });

  it('publishes only what changed, and only while a panel is detached', () => {
    const satellite = peer();
    start();
    satellite.received.length = 0;

    TestBed.inject(OutputLog).info('compiler', 'docked');
    TestBed.tick();
    expect(satellite.received).toEqual([]);

    session.native.set({ bottomPanel: true, inspector: false, editor: false });
    TestBed.tick();
    satellite.received.length = 0;

    session.allDiagnostics.set([diagnostic(7)]);
    TestBed.tick();

    expect(satellite.received).toEqual([
      { kind: 'state', patch: { diagnostics: [diagnostic(7)] } },
    ]);
  });

  it('answers a command only after posting the state it changed', async () => {
    start();
    const satellite = peer();

    const replies = await command(satellite, {
      kind: 'edit',
      shaderId: 'waves',
      docId: 'image',
      base: textFingerprint(IMAGE),
      source: 'void main() { /* new */ }',
    });

    expect(session.store.setDocSource).toHaveBeenCalledWith('image', 'void main() { /* new */ }');
    expect(replies.map((reply) => reply.kind)).toEqual(['state', 'done']);
    const [state, done] = replies;
    expect(state.kind === 'state' && state.patch.documents?.[0].source).toBe(
      'void main() { /* new */ }',
    );
    expect(done).toEqual({ kind: 'done', client: 'panel', seq: 1, ok: true });
  });

  it('refuses an edit for another shader, an unknown document, an oversized text or a changed one', async () => {
    start();
    const satellite = peer();
    const base = textFingerprint(IMAGE);

    const refused: [SessionCommand, string][] = [
      [{ kind: 'edit', shaderId: 'other', docId: 'image', base, source: 'x' }, 'other-shader'],
      [{ kind: 'edit', shaderId: 'waves', docId: 'nope', base, source: 'x' }, 'invalid'],
      [
        { kind: 'edit', shaderId: 'waves', docId: 'image', base, source: 'x'.repeat(200_001) },
        'too-large',
      ],
      [
        { kind: 'edit', shaderId: 'waves', docId: 'image', base, source: 42 as unknown as string },
        'invalid',
      ],
      [
        {
          kind: 'edit',
          shaderId: 'waves',
          docId: 'image',
          base: textFingerprint('typed on another text'),
          source: 'x',
        },
        'conflict',
      ],
    ];
    for (const [index, [each, reason]] of refused.entries()) {
      const replies = await command(satellite, each, index + 1);
      expect(replies.at(-1)).toEqual({
        kind: 'done',
        client: 'panel',
        seq: index + 1,
        ok: false,
        reason,
      });
    }
    expect(session.store.setDocSource).not.toHaveBeenCalled();
  });

  it('answers a refusal with its whole state, so the panel window drops what it showed', async () => {
    start();
    const satellite = peer();

    const replies = await command(satellite, { kind: 'set-param', key: 'speed', value: 'fast' });

    const [state, done] = replies;
    expect(state.kind === 'state' && Object.keys(state.patch).sort()).toEqual(
      [...SESSION_FIELDS].sort(),
    );
    expect(done).toMatchObject({ kind: 'done', ok: false, reason: 'invalid' });
  });

  it('says nothing before its session settles, and holds back while a recovered draft waits', () => {
    session.staleRecovery.set({});
    const satellite = peer();
    start();
    satellite.channel.postMessage({ kind: 'hello', client: 'panel' });
    session.native.set({ bottomPanel: true, inspector: false, editor: false });
    TestBed.tick();
    expect(satellite.received).toEqual([{ kind: 'host', ready: false }]);

    session.staleRecovery.set(null);
    TestBed.tick();
    expect(satellite.received[1]).toEqual({ kind: 'host', ready: true });
    satellite.channel.postMessage({ kind: 'hello', client: 'panel' });
    expect(satellite.received.at(-1)?.kind).toBe('state');
  });

  it('settles after a few seconds without a shader, so panel windows are never left waiting', () => {
    vi.useFakeTimers();
    try {
      session.record.set(null);
      const satellite = peer();
      start();
      vi.advanceTimersByTime(5_000);
      TestBed.tick();
      expect(satellite.received).toEqual([
        { kind: 'host', ready: false },
        { kind: 'host', ready: true },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a reveal for a detached editor whose window is reopening until it says hello', () => {
    session.native.set({ bottomPanel: false, inspector: false, editor: true });
    session.windowOpen.set(false);
    start();
    const satellite = peer();

    TestBed.inject(EditorNavigation).reveal('image', 9);
    TestBed.tick();
    expect(satellite.received.some((message) => message.kind === 'reveal-in-editor')).toBe(false);

    satellite.channel.postMessage({ kind: 'hello', client: 'inspector', window: 'inspector' });
    expect(satellite.received.some((message) => message.kind === 'reveal-in-editor')).toBe(false);
    satellite.channel.postMessage({ kind: 'hello', client: 'editor', window: 'editor' });
    expect(satellite.received.at(-1)).toEqual({
      kind: 'reveal-in-editor',
      docId: 'image',
      line: 9,
    });
  });

  it('does not re-send the documents when only the render changed', () => {
    session.native.set({ bottomPanel: false, inspector: true, editor: true });
    const satellite = peer();
    start();
    satellite.received.length = 0;

    session.documents.set(session.documents().map((document) => ({ ...document })));
    session.render.set({ ...session.render() });
    TestBed.tick();

    const patches = satellite.received.flatMap((message) =>
      message.kind === 'state' ? Object.keys(message.patch) : [],
    );
    expect(patches).toContain('render');
    expect(patches).not.toContain('documents');
  });

  it('validates every inspector change before making it', async () => {
    start();
    const satellite = peer();
    const ok = async (each: SessionCommand) => (await command(satellite, each)).at(-1);

    expect(await ok({ kind: 'set-param', key: 'speed', value: 99 })).toMatchObject({ ok: true });
    expect(session.store.setParam).toHaveBeenLastCalledWith('speed', 10);
    expect(await ok({ kind: 'set-param', key: 'speed', value: 'fast' })).toMatchObject({
      ok: false,
    });
    expect(await ok({ kind: 'set-param', key: 'unknown', value: 1 })).toMatchObject({ ok: false });

    expect(await ok({ kind: 'set-render', render: { postProcessing: 'nope' } })).toMatchObject({
      ok: true,
    });
    expect(session.store.setRender).toHaveBeenLastCalledWith(
      validateRender({ postProcessing: 'nope' }),
    );
    expect(await ok({ kind: 'clear-texture', channel: 7 })).toMatchObject({ ok: false });
    expect(
      await ok({ kind: 'set-channel-settings', channel: 1, patch: { wrap: 'x' } }),
    ).toMatchObject({ ok: false });
    expect(
      await ok({ kind: 'set-channel-settings', channel: 1, patch: { wrap: 'repeat' } }),
    ).toMatchObject({ ok: true });
    expect(session.store.setChannelSettings).toHaveBeenCalledWith(1, { wrap: 'repeat' });

    expect(await ok({ kind: 'set-system', patch: { resolutionScale: 9 } })).toMatchObject({
      ok: false,
    });
    expect(await ok({ kind: 'set-system', patch: { paused: true } })).toMatchObject({ ok: true });
    expect(session.preferences().paused).toBe(true);

    expect(await ok({ kind: 'apply-preset', presetId: 'missing' })).toMatchObject({ ok: false });
    expect(await ok({ kind: 'save-preset', name: '  ', withRender: false })).toMatchObject({
      ok: false,
    });
    expect(await ok({ kind: 'save-preset', name: ' Calm ', withRender: true })).toMatchObject({
      ok: true,
    });
    expect(session.store.savePreset).toHaveBeenCalledWith('Calm', true);

    expect(await ok({ kind: 'inspector-tab', tab: 'presets' })).toMatchObject({ ok: true });
    expect(session.inspectorTab()).toBe('presets');
    expect(await ok({ kind: 'inspector-tab', tab: 'nope' as 'presets' })).toMatchObject({
      ok: false,
    });

    // Only the scale the profiler itself suggested.
    expect(await ok({ kind: 'apply-profiler-suggestion', scale: 0.5 })).toMatchObject({
      ok: false,
    });
    expect(await ok({ kind: 'not-a-command' } as unknown as SessionCommand)).toMatchObject({
      ok: false,
    });
  });

  it('keeps the bottom panel tab, the log and the editor in the main window', async () => {
    start();
    const satellite = peer();
    const log = TestBed.inject(OutputLog);
    log.info('compiler', 'compiled');

    await command(satellite, { kind: 'bottom-panel-tab', tab: 'profiler' });
    await command(satellite, { kind: 'clear-output' });
    await command(satellite, { kind: 'reveal', docId: 'image', line: 4 });
    const saved = await command(satellite, { kind: 'save' });

    expect(session.preferences().bottomPanelTab).toBe('profiler');
    expect(log.entries()).toEqual([]);
    expect(session.layout.openEditor).toHaveBeenCalled();
    expect(TestBed.inject(EditorNavigation).request()).toMatchObject({ docId: 'image', line: 4 });
    expect(saved.at(-1)).toMatchObject({ kind: 'done', ok: true });
    expect(session.store.save).toHaveBeenCalled();
  });

  it("sends a reveal to the detached editor's window instead of a docked editor", () => {
    session.native.set({ bottomPanel: false, inspector: false, editor: true });
    start();
    const satellite = peer();
    const navigation = TestBed.inject(EditorNavigation);

    navigation.reveal('@config', 0);
    TestBed.tick();

    expect(session.store.selectDoc).toHaveBeenCalledWith('@config');
    expect(satellite.received.at(-1)).toEqual({
      kind: 'reveal-in-editor',
      docId: '@config',
      line: 0,
    });
    expect(navigation.request()).toBeNull();
  });

  it('leaves profiling to the docked panel until the panel is detached, then profiles its tab', async () => {
    start();
    TestBed.tick();
    expect(session.renderer.setProfilingEnabled).not.toHaveBeenCalled();

    session.preferences.update((prefs) => ({
      ...prefs,
      bottomPanelOpen: true,
      bottomPanelTab: 'profiler',
    }));
    session.native.set({ bottomPanel: true, inspector: false, editor: false });
    TestBed.tick();
    expect(session.renderer.setProfilingEnabled).toHaveBeenLastCalledWith(true);

    session.native.set({ bottomPanel: false, inspector: false, editor: false });
    TestBed.tick();
    expect(session.renderer.setProfilingEnabled).toHaveBeenLastCalledWith(false);
  });

  it('does nothing where BroadcastChannel does not exist', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    expect(() => start()).not.toThrow();
  });
});

describe('SessionMirror (panel window)', () => {
  let main: ReturnType<typeof peer>;

  beforeEach(() => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    main = peer();
    TestBed.configureTestingModule({});
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    FakeBroadcastChannel.reset();
    vi.unstubAllGlobals();
  });

  const start = () => {
    const mirror = TestBed.inject(SessionMirror);
    mirror.start();
    return mirror;
  };
  const publish = (message: SessionMessage) => main.channel.postMessage(message);
  const commands = () =>
    main.received.filter(
      (message): message is Extract<SessionMessage, { kind: 'command' }> =>
        message.kind === 'command',
    );

  it('says hello and shows what the main window publishes', () => {
    const mirror = start();
    expect(main.received).toEqual([{ kind: 'hello', client: mirror.client }]);

    publish({ kind: 'state', patch: { diagnostics: [diagnostic(2)], dirty: true } });

    expect(mirror.field('diagnostics')()).toEqual([diagnostic(2)]);
    expect(mirror.field('dirty')()).toBe(true);
  });

  it('takes only known fields of the right shape, and only log entries it can show', () => {
    const mirror = start();

    publish({
      kind: 'state',
      patch: {
        dirty: 'yes',
        documents: 'none',
        entries: [
          { id: 1, timestamp: 0, level: 'info', source: 'compiler', message: 'ok' },
          { id: 2, timestamp: 0, level: 'shout', source: 'compiler', message: 'bad' },
        ],
        surprise: 1,
      } as unknown as Record<string, unknown>,
    });

    expect(mirror.state()).toEqual({
      ...EMPTY_SESSION,
      entries: [{ id: 1, timestamp: 0, level: 'info', source: 'compiler', message: 'ok' }],
    });
  });

  it("shows a change at once and holds back the main window's older state until it is answered", async () => {
    const mirror = start();
    publish({ kind: 'state', patch: { params: { speed: 1 } } });

    const answered = mirror.send(
      { kind: 'set-param', key: 'speed', value: 3 },
      { params: { speed: 3 } },
    );
    expect(mirror.field('params')()).toEqual({ speed: 3 });

    // Posted before the command reached the main window: older than what was typed here.
    publish({ kind: 'state', patch: { params: { speed: 2 }, fps: 30 } });
    expect(mirror.field('params')()).toEqual({ speed: 3 });
    expect(mirror.field('fps')()).toBe(0);

    const [sent] = commands();
    publish({ kind: 'state', patch: { params: { speed: 3 } } });
    publish({ kind: 'done', client: mirror.client, seq: sent.seq, ok: true });

    expect(await answered).toBe(true);
    expect(mirror.field('params')()).toEqual({ speed: 3 });
    expect(mirror.field('fps')()).toBe(30);
  });

  it("ignores another window's answers", () => {
    const mirror = start();
    void mirror.send({ kind: 'set-param', key: 'speed', value: 3 }, { params: { speed: 3 } });

    publish({ kind: 'done', client: 'someone-else', seq: 1, ok: true });
    publish({ kind: 'state', patch: { params: { speed: 1 } } });

    expect(mirror.field('params')()).toEqual({ speed: 3 });
  });

  it('resends what only sets a value once a restarted main window is back, and drops the rest', async () => {
    const mirror = start();
    const typed: SessionCommand = {
      kind: 'edit',
      shaderId: 'waves',
      docId: 'image',
      base: textFingerprint(IMAGE),
      source: 'typed',
    };
    const edit = mirror.send(typed, { documents: [] });
    const save = mirror.send({ kind: 'save' });
    main.received.length = 0;

    // Restarted: nothing goes out until its session settles, and the view is live again.
    publish({ kind: 'host', ready: false });
    expect(await save).toBe(false);
    const param = mirror.send({ kind: 'set-param', key: 'speed', value: 2 });
    publish({ kind: 'state', patch: { fps: 42 } });
    expect(mirror.field('fps')()).toBe(42);
    expect(main.received).toEqual([]);

    publish({ kind: 'host', ready: true });
    const [resent, then] = commands();
    expect(resent.command).toEqual(typed);
    expect(then.command).toEqual({ kind: 'set-param', key: 'speed', value: 2 });
    expect(main.received.at(-1)).toEqual({ kind: 'hello', client: mirror.client });
    publish({ kind: 'done', client: mirror.client, seq: then.seq, ok: true });
    expect(await param).toBe(true);

    publish({ kind: 'done', client: mirror.client, seq: resent.seq, ok: true });
    expect(await edit).toBe(true);
  });

  it('passes a reveal on to the detached editor', () => {
    const mirror = start();

    publish({ kind: 'reveal-in-editor', docId: 'image', line: 12 });
    publish({ kind: 'reveal-in-editor', docId: 'image', line: 12 });
    publish({ kind: 'reveal-in-editor', docId: 7, line: 1 } as unknown as SessionMessage);

    expect(mirror.revealRequest()).toEqual({ docId: 'image', line: 12, id: 2 });
  });

  it('refuses every command where BroadcastChannel does not exist', async () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const mirror = start();

    expect(await mirror.send({ kind: 'save' })).toBe(false);
    expect(mirror.state()).toBe(EMPTY_SESSION);
  });
});

describe('SessionHost and SessionMirror together', () => {
  let session: FakeMainSession;

  beforeEach(() => {
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    session = new FakeMainSession();
    session.native.set({ bottomPanel: false, inspector: true, editor: true });
    TestBed.configureTestingModule({ providers: session.providers() });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    FakeBroadcastChannel.reset();
    vi.unstubAllGlobals();
  });

  it('lands every keystroke in the one session, and never shows an older text after a newer one', async () => {
    const host = TestBed.inject(SessionHost);
    host.start();
    TestBed.tick();
    // The panel window lives in another injector, as it does in its own window.
    const mirror = TestBed.runInInjectionContext(() => new SessionMirror());
    mirror.start();
    await flushPromises();

    const seen: string[] = [];
    let text = 'void main() {}';
    const answers: Promise<boolean>[] = [];
    for (const key of ' // hello') {
      text += key;
      const documents = mirror
        .field('documents')()
        .map((document) => (document.id === 'image' ? { ...document, source: text } : document));
      const base = textFingerprint(mirror.field('documents')()[0].source);
      answers.push(
        mirror.send(
          { kind: 'edit', shaderId: 'waves', docId: 'image', base, source: text },
          { documents },
        ),
      );
      seen.push(mirror.field('documents')()[0].source);
    }
    expect(await Promise.all(answers)).toEqual(answers.map(() => true));
    TestBed.tick();
    seen.push(mirror.field('documents')()[0].source);

    expect(session.documents()[0].source).toBe('void main() {} // hello');
    // Every text shown is at least as long as the one before it: nothing went back.
    expect(
      seen.every((shown, index) => index === 0 || shown.length >= seen[index - 1].length),
    ).toBe(true);
    expect(seen.at(-1)).toBe('void main() {} // hello');
    expect(mirror.field('render')()).toEqual(DEFAULT_RENDER);
  });
});
