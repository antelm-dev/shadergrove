import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AsyncBroadcastChannel } from '../testing/async-broadcast-channel';
import { FAKE_DOCUMENTS, FakeMainSession, explorerProject } from '../testing/fake-session';
import { SessionHost } from './session-host';
import { SessionMirror } from './session-mirror';
import {
  SESSION_CHANNEL,
  textFingerprint,
  type SessionCommand,
  type SessionMessage,
} from './session-protocol';

/**
 * The main window and a detached editor over a channel that delivers like the
 * real one — later, one message per task — so answers, echoes and changes made
 * in the main window interleave as they do between two windows.
 */
describe('the session channel, delivered asynchronously', () => {
  const IMAGE = FAKE_DOCUMENTS[0].source;
  let session: FakeMainSession;

  beforeEach(() => {
    vi.stubGlobal('BroadcastChannel', AsyncBroadcastChannel);
    session = new FakeMainSession();
    session.native.set({ bottomPanel: false, inspector: false, editor: true });
    TestBed.configureTestingModule({ providers: session.providers() });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    AsyncBroadcastChannel.reset();
    vi.unstubAllGlobals();
  });

  /** One task turn: whatever was posted before it lands, and the main window's effects run. */
  const turn = async () => {
    await new Promise((resolve) => setTimeout(resolve));
    TestBed.tick();
  };
  const settle = async () => {
    for (let i = 0; i < 12; i++) await turn();
  };

  const startHost = () => {
    TestBed.inject(SessionHost).start();
    TestBed.tick();
  };
  /** The detached editor's half, in an injection context of its own as in its own window. */
  const startMirror = () => {
    const mirror = TestBed.runInInjectionContext(() => new SessionMirror());
    mirror.start('editor');
    return mirror;
  };

  const shown = (mirror: SessionMirror) =>
    mirror
      .field('documents')()
      .find((document) => document.id === 'image')?.source;

  /** A keystroke as the editor window sends it: the whole text, naming the text it was typed on. */
  const type = (mirror: SessionMirror, source: string, typedOn = shown(mirror) ?? IMAGE) => {
    const command: SessionCommand = {
      kind: 'edit',
      shaderId: 'waves',
      docId: 'image',
      base: textFingerprint(typedOn),
      source,
    };
    const documents = mirror
      .field('documents')()
      .map((document) => (document.id === 'image' ? { ...document, source } : document));
    return mirror.send(command, { documents });
  };

  const textOf = (mirror: SessionMirror, docId: string) =>
    mirror
      .field('documents')()
      .find((document) => document.id === docId)?.source;

  /** A keystroke in any document, as the editor window sends it. */
  const typeIn = (mirror: SessionMirror, docId: string, source: string) => {
    const typedOn = textOf(mirror, docId) ?? '';
    const documents = mirror
      .field('documents')()
      .map((document) => (document.id === docId ? { ...document, source } : document));
    return mirror.send(
      { kind: 'edit', shaderId: 'waves', docId, base: textFingerprint(typedOn), source },
      { documents },
    );
  };

  it('drops a keystroke for a document the main window deleted meanwhile, and moves off it', async () => {
    session.useProject(explorerProject());
    startHost();
    const mirror = startMirror();
    await settle();
    await mirror.send({ kind: 'select-doc', docId: 'buf-a' }, { activeDocId: 'buf-a' });

    const first = typeIn(mirror, 'buf-a', 'a1');
    await turn();
    // The main window deletes the buffer before the editor has heard of its answer…
    session.store.removeBufferPass('buf-a');
    // …and the editor, not knowing yet, types on.
    const second = typeIn(mirror, 'buf-a', 'a12');
    await settle();

    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect(mirror.refusal()?.reason).toBe('conflict');
    expect(session.store.setDocSource).toHaveBeenCalledTimes(1);
    expect(session.documents().some((document) => document.id === 'buf-a')).toBe(false);
    // The editor shows the main window's documents, on the one the main window moved to.
    expect(textOf(mirror, 'buf-a')).toBeUndefined();
    expect(mirror.field('activeDocId')()).toBe('image');
    const passes = mirror.field('explorer')().tree.nodes[0];
    expect(passes.children.map((node) => node.id)).toEqual(['image', 'buf-b']);
  });

  it('keeps typing into a document the main window renamed meanwhile: a rename keeps its id', async () => {
    session.useProject(explorerProject());
    startHost();
    const mirror = startMirror();
    await settle();

    const first = typeIn(mirror, 'file-1', 'float noise; // a');
    await turn();
    session.store.renameSourceFile('file-1', 'hash.glsl');
    const second = typeIn(mirror, 'file-1', 'float noise; // ab');
    await settle();

    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(mirror.refusal()).toBeNull();
    const file = session.documents().find((document) => document.id === 'file-1');
    expect(file).toMatchObject({ name: 'hash.glsl', source: 'float noise; // ab' });
    expect(
      mirror
        .field('documents')()
        .find((document) => document.id === 'file-1'),
    ).toMatchObject({ name: 'hash.glsl', source: 'float noise; // ab' });
  });

  it("changes the main window's documents from the editor window, in order with its keystrokes", async () => {
    session.useProject(explorerProject());
    startHost();
    const mirror = startMirror();
    await settle();

    // Typed, then deleted, then typed again before any answer came back.
    const typed = typeIn(mirror, 'file-1', 'float noise; // kept?');
    const deleted = mirror.send({ kind: 'delete-doc', shaderId: 'waves', docId: 'file-1' });
    const late = typeIn(mirror, 'file-1', 'float noise; // late');
    const added = mirror.send({ kind: 'add-file', shaderId: 'waves', name: 'fresh.glsl' });
    await settle();

    expect(await Promise.all([typed, deleted, late, added])).toEqual([true, true, false, true]);
    expect(session.documents().map((document) => document.name)).toEqual([
      'Image',
      'Buffer A',
      'Buffer B',
      'fresh.glsl',
      'Config',
    ]);
    // The new file is open in both windows, and its row is the active one.
    const created = session.documents().find((document) => document.name === 'fresh.glsl')!;
    expect(mirror.field('activeDocId')()).toBe(created.id);
    const includes = mirror.field('explorer')().tree.nodes[1];
    expect(includes.children.map((node) => [node.name, node.status.active])).toEqual([
      ['fresh.glsl', true],
    ]);
  });

  it('never lets an answer asked for in one shader land in the one the main window switched to', async () => {
    session.useProject(explorerProject());
    startHost();
    const mirror = startMirror();
    await settle();

    // The user answers a rename prompt after the main window opened another shader.
    session.record.set({ id: 'other', updatedAt: '2024-02-01T00:00:00.000Z' });
    const renamed = mirror.send({
      kind: 'rename-doc',
      shaderId: 'waves',
      docId: 'buf-a',
      name: 'Blur',
    });
    await settle();

    expect(await renamed).toBe(false);
    expect(mirror.refusal()?.reason).toBe('other-shader');
    expect(session.store.renamePassById).not.toHaveBeenCalled();
  });

  it('never overwrites a change the main window made while the editor was typing (F1)', async () => {
    startHost();
    const mirror = startMirror();
    await settle();

    const first = type(mirror, `${IMAGE} a`);
    // The main window takes the keystroke…
    await turn();
    // …then an agent patches the same document, before the editor has heard of either.
    session.store.setDocSource('image', 'PATCHED BY MAIN');
    const second = type(mirror, `${IMAGE} ab`);
    await settle();

    expect(await first).toBe(true);
    expect(await second).toBe(false);
    expect(session.documents()[0].source).toBe('PATCHED BY MAIN');
    // The editor gives up the refused keystroke for the main window's text, and says why.
    expect(shown(mirror)).toBe('PATCHED BY MAIN');
    expect(mirror.refusal()?.reason).toBe('conflict');
  });

  it("drops what it showed for a refused change and shows the main window's again (F2)", async () => {
    startHost();
    const mirror = startMirror();
    await settle();

    const pasted = type(mirror, 'x'.repeat(200_001));
    expect(shown(mirror)).toHaveLength(200_001);
    await settle();

    expect(await pasted).toBe(false);
    expect(shown(mirror)).toBe(IMAGE);
    expect(mirror.refusal()?.reason).toBe('too-large');

    // And the next keystroke, typed on the main window's text, lands.
    const next = type(mirror, `${IMAGE} ok`);
    await settle();
    expect(await next).toBe(true);
    expect(session.documents()[0].source).toBe(`${IMAGE} ok`);
  });

  it('keeps showing the main window after a reload that never settles (F4)', async () => {
    // The main window is gone: nobody answers.
    const main = new AsyncBroadcastChannel(SESSION_CHANNEL);
    const received: SessionMessage[] = [];
    main.onmessage = ({ data }) => received.push(data as SessionMessage);
    const mirror = startMirror();
    await settle();
    void type(mirror, `${IMAGE} typed`);
    await settle();

    // A new main window starts and publishes, without ever settling on a shader.
    main.postMessage({ kind: 'host', ready: false } satisfies SessionMessage);
    main.postMessage({ kind: 'state', patch: { fps: 42 } } satisfies SessionMessage);
    await settle();
    expect(mirror.field('fps')()).toBe(42);

    // Once it does settle, the keystroke it never answered goes to it.
    received.length = 0;
    main.postMessage({ kind: 'host', ready: true } satisfies SessionMessage);
    await settle();
    expect(received.find((message) => message.kind === 'command')).toMatchObject({
      command: { kind: 'edit', source: `${IMAGE} typed` },
    });
  });

  it('does not replay a keystroke over newer text the reloaded main window loaded (F3)', async () => {
    // The keystroke goes to a main window that dies before it answers.
    const mirror = startMirror();
    await settle();
    void type(mirror, `${IMAGE} typed`, IMAGE);
    await settle();

    // The reloaded main window loads a newer version, saved from elsewhere meanwhile.
    session.documents.set(
      FAKE_DOCUMENTS.map((document) =>
        document.id === 'image' ? { ...document, source: 'SERVER V2' } : document,
      ),
    );
    startHost();
    await settle();

    expect(session.store.setDocSource).not.toHaveBeenCalled();
    expect(session.documents()[0].source).toBe('SERVER V2');
    expect(shown(mirror)).toBe('SERVER V2');
  });

  it('keeps what was typed when the main window dies with an older echo on its way (G1)', async () => {
    const main = new AsyncBroadcastChannel(SESSION_CHANNEL);
    const received: SessionMessage[] = [];
    main.onmessage = ({ data }) => received.push(data as SessionMessage);
    const mirror = startMirror();
    main.postMessage({
      kind: 'state',
      patch: { shader: { id: 'waves', updatedAt: 'v1' }, documents: FAKE_DOCUMENTS },
    } satisfies SessionMessage);
    await settle();
    void type(mirror, `${IMAGE} a`, IMAGE);
    void type(mirror, `${IMAGE} ab`, `${IMAGE} a`);
    await settle();
    const [first] = received.filter(
      (message): message is Extract<SessionMessage, { kind: 'command' }> =>
        message.kind === 'command',
    );

    // The first keystroke is answered, its echo held behind the second; then the main window dies.
    main.postMessage({
      kind: 'state',
      patch: {
        documents: FAKE_DOCUMENTS.map((document) =>
          document.id === 'image' ? { ...document, source: `${IMAGE} a` } : document,
        ),
      },
    } satisfies SessionMessage);
    main.postMessage({
      kind: 'done',
      client: first.client,
      seq: first.seq,
      ok: true,
    } satisfies SessionMessage);
    main.postMessage({ kind: 'host', ready: false } satisfies SessionMessage);
    await settle();

    expect(shown(mirror)).toBe(`${IMAGE} ab`);
  });

  it('takes a replayed keystroke the reloaded draft already carries as done, quietly (G2)', async () => {
    const mirror = startMirror();
    await settle();
    // The keystroke goes to a main window that dies before it answers…
    const typed = type(mirror, `${IMAGE} typed`, IMAGE);
    await settle();

    // …but its draft mirror had already saved the text the reloaded window restores.
    session.documents.set(
      FAKE_DOCUMENTS.map((document) =>
        document.id === 'image' ? { ...document, source: `${IMAGE} typed` } : document,
      ),
    );
    startHost();
    await settle();

    expect(await typed).toBe(true);
    expect(mirror.refusal()).toBeNull();
    expect(shown(mirror)).toBe(`${IMAGE} typed`);
  });

  it('lands an interleaved burst whole, never showing an older text after a newer one', async () => {
    startHost();
    const mirror = startMirror();
    await settle();

    const seen: string[] = [];
    const answers: Promise<boolean>[] = [];
    let text = IMAGE;
    for (const [index, key] of [...' // burst'].entries()) {
      text += key;
      answers.push(type(mirror, text));
      seen.push(shown(mirror)!);
      // The main window keeps changing other things meanwhile.
      session.fps.set(30 + index);
      for (let i = 0; i < index % 3; i++) await turn();
      seen.push(shown(mirror)!);
    }
    await settle();
    seen.push(shown(mirror)!);

    expect(await Promise.all(answers)).toEqual(answers.map(() => true));
    expect(session.documents()[0].source).toBe(`${IMAGE} // burst`);
    expect(seen.every((each, index) => index === 0 || each.length >= seen[index - 1].length)).toBe(
      true,
    );
    expect(seen.at(-1)).toBe(`${IMAGE} // burst`);
    expect(mirror.field('fps')()).toBe(38);
    expect(mirror.refusal()).toBeNull();
  });
});
