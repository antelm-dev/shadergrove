import { DestroyRef, Injectable, computed, inject, signal, type Signal } from '@angular/core';

import {
  EMPTY_SESSION,
  REPLAYABLE_COMMANDS,
  SESSION_CHANNEL,
  acceptPatch,
  type SessionCommand,
  type SessionField,
  type SessionMessage,
  type SessionRefusal,
  type SessionState,
} from './session-protocol';
import type { SatelliteKind } from '../../output-mode';

interface Pending {
  readonly command: SessionCommand;
  /** Changed here ahead of the answer: the main window's state waits until it confirms. */
  readonly local: boolean;
  readonly resolve: (ok: boolean) => void;
}

/** A command the main window refused, for this window to say so. */
export interface SessionRefusalNotice {
  readonly reason: SessionRefusal;
  /** New for every refusal, so the same reason twice is still two notices. */
  readonly id: number;
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
  /**
   * Between a main window's restart and its session settling: commands wait
   * here, in order, and go to the new main window once it is ready.
   */
  private rejoining: Pending[] | null = null;
  private readonly fields = new Map<SessionField, Signal<unknown>>();
  private window: SatelliteKind | undefined;

  private refusalId = 0;
  /** The last command the main window refused, if any. */
  readonly refusal = signal<SessionRefusalNotice | null>(null);

  private revealId = 0;
  readonly revealRequest = signal<EditorRevealRequest | null>(null);

  /** `window` names this panel window to the main window, for what waits on that window. */
  start(window?: SatelliteKind): void {
    if (typeof BroadcastChannel === 'undefined' || this.channel) return;
    this.window = window;
    const channel = new BroadcastChannel(SESSION_CHANNEL);
    this.channel = channel;
    channel.onmessage = ({ data }: MessageEvent<SessionMessage>) => this.receive(data);
    this.destroyRef.onDestroy(() => {
      channel.close();
      this.channel = null;
      for (const pending of [...this.pending.values(), ...(this.rejoining ?? [])]) {
        pending.resolve(false);
      }
      this.pending.clear();
      this.rejoining = null;
    });
    // Whatever the main window already has: it answers with all of it.
    this.hello();
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
    if (this.rejoining) {
      this.rejoining.push(pending);
      return;
    }
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
        // The main window's whole state came just before: it replaces what was shown ahead.
        if (message.ok !== true) {
          this.refusal.set({ reason: message.reason ?? 'invalid', id: ++this.refusalId });
        }
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
   * `ready: false`: the main window restarted, so nothing it had not answered
   * will be answered. What only sets a value (an edit's whole text, a parameter)
   * waits, with every command sent from now on, for its session to settle; the
   * rest is reported as not done. This window keeps showing what it had: the
   * new main window publishes nothing before it settles.
   *
   * `ready: true`: the session settled. The waiting commands go out in order —
   * an edit still names the text it was typed on, so one the reload overtook is
   * refused rather than replayed over newer text — and this window asks for the
   * whole state again.
   */
  private rejoin(ready: boolean): void {
    if (!ready) {
      const unanswered = [...this.pending.values()];
      this.pending.clear();
      // Held echoes are older than what was typed here: dropped, not shown. The new main
      // window's state replaces them once it settles, after the replays below.
      this.held = {};
      this.rejoining ??= [];
      for (const pending of unanswered) {
        if (REPLAYABLE_COMMANDS.has(pending.command.kind)) this.rejoining.push(pending);
        else pending.resolve(false);
      }
      return;
    }
    const waiting = this.rejoining ?? [];
    this.rejoining = null;
    for (const pending of waiting) this.dispatch(pending);
    this.hello();
  }

  private hello(): void {
    this.post({
      kind: 'hello',
      client: this.client,
      ...(this.window ? { window: this.window } : {}),
    });
  }

  private post(message: SessionMessage): void {
    this.channel?.postMessage(message);
  }
}
