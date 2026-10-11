import { DestroyRef, Injectable, computed, inject, signal, type Signal } from '@angular/core';

import {
  EMPTY_SESSION,
  REPLAYABLE_COMMANDS,
  SESSION_CHANNEL,
  acceptPatch,
  type SessionCommand,
  type SessionField,
  type SessionMessage,
  type SessionState,
} from './session-protocol';

interface Pending {
  readonly command: SessionCommand;
  /** Changed here ahead of the answer: the main window's state waits until it confirms. */
  readonly local: boolean;
  readonly resolve: (ok: boolean) => void;
}

/** A line the main window asks the detached editor to show. */
export interface EditorRevealRequest {
  readonly docId: string;
  readonly line: number;
  /** New for every request, so the same line twice is still two requests. */
  readonly id: number;
}

/**
 * A native panel window's half of the session channel: a read-only view of
 * the main window's session, and the commands that ask it for a change.
 *
 * A command may change this view at once (`local`), ahead of the main
 * window's answer, so a slider or a keystroke never waits on a round trip.
 * Until every such command is answered, the main window's state is held back
 * rather than shown: it can only be older than what was typed here. Without
 * `BroadcastChannel` the view simply stays empty and commands are refused.
 */
@Injectable({ providedIn: 'root' })
export class SessionMirror {
  private readonly destroyRef = inject(DestroyRef);
  private channel: BroadcastChannel | null = null;

  /** Tells this window's commands apart from another panel window's. */
  readonly client = crypto.randomUUID();

  private readonly current = signal<SessionState>(EMPTY_SESSION);
  readonly state = this.current.asReadonly();

  private held: Partial<SessionState> = {};
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly fields = new Map<SessionField, Signal<unknown>>();

  private revealId = 0;
  readonly revealRequest = signal<EditorRevealRequest | null>(null);

  start(): void {
    if (typeof BroadcastChannel === 'undefined' || this.channel) return;
    const channel = new BroadcastChannel(SESSION_CHANNEL);
    this.channel = channel;
    channel.onmessage = ({ data }: MessageEvent<SessionMessage>) => this.receive(data);
    this.destroyRef.onDestroy(() => {
      channel.close();
      this.channel = null;
      for (const pending of this.pending.values()) pending.resolve(false);
      this.pending.clear();
    });
    // Whatever the main window already has: it answers with all of it.
    this.post({ kind: 'hello', client: this.client });
  }

  /** One field of the main window's session, as this window shows it. */
  field<K extends SessionField>(name: K): Signal<SessionState[K]> {
    let field = this.fields.get(name);
    if (!field) {
      field = computed(() => this.current()[name]);
      this.fields.set(name, field);
    }
    return field as Signal<SessionState[K]>;
  }

  /**
   * Asks the main window to carry out a command; resolves with whether it did.
   * `local` is shown here at once, ahead of the answer.
   */
  send(command: SessionCommand, local?: Partial<SessionState>): Promise<boolean> {
    if (!this.channel) return Promise.resolve(false);
    if (local) this.current.update((state) => ({ ...state, ...local }));
    return new Promise((resolve) => this.dispatch({ command, local: !!local, resolve }));
  }

  private dispatch(pending: Pending): void {
    const seq = ++this.seq;
    this.pending.set(seq, pending);
    this.post({ kind: 'command', client: this.client, seq, command: pending.command });
  }

  private receive(message: SessionMessage): void {
    switch (message?.kind) {
      case 'state': {
        const patch = acceptPatch(message.patch);
        if (this.waiting()) Object.assign(this.held, patch);
        else this.current.update((state) => ({ ...state, ...patch }));
        return;
      }
      case 'done': {
        if (message.client !== this.client) return;
        const pending = this.pending.get(message.seq);
        if (!pending) return;
        this.pending.delete(message.seq);
        pending.resolve(message.ok === true);
        if (!this.waiting()) this.release();
        return;
      }
      case 'host':
        this.rejoin(message.ready === true);
        return;
      case 'reveal-in-editor':
        if (typeof message.docId !== 'string' || !Number.isInteger(message.line)) return;
        this.revealRequest.set({
          docId: message.docId,
          line: Math.max(0, message.line),
          id: ++this.revealId,
        });
        return;
    }
  }

  /** Whether a change made here is still unanswered. */
  private waiting(): boolean {
    for (const pending of this.pending.values()) if (pending.local) return true;
    return false;
  }

  private release(): void {
    const held = this.held;
    this.held = {};
    if (Object.keys(held).length > 0) this.current.update((state) => ({ ...state, ...held }));
  }

  /**
   * The main window restarted, so nothing it had not answered will be answered.
   * Once its session is back, what only sets a value (an edit's whole text, a
   * parameter) is sent again; the rest is reported as not done.
   */
  private rejoin(ready: boolean): void {
    if (ready) {
      const unanswered = [...this.pending.values()];
      this.pending.clear();
      this.held = {};
      for (const pending of unanswered) {
        if (REPLAYABLE_COMMANDS.has(pending.command.kind)) this.dispatch(pending);
        else pending.resolve(false);
      }
    }
    this.post({ kind: 'hello', client: this.client });
  }

  private post(message: SessionMessage): void {
    this.channel?.postMessage(message);
  }
}
