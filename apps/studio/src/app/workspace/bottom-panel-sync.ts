import { DestroyRef, Injectable, Injector, effect, inject, signal, untracked } from '@angular/core';

import type { CompileDiagnostic } from '@shadergrove/shared/diagnostic';
import { EditorNavigation } from '../editor/editor-navigation';
import { SurfaceLayoutService } from '../surfaces/surface-layout';
import { OutputLog, type OutputLogEntry } from '../ui/bottom-panel/output-log';
import { ShaderStore } from './shader-store';

/**
 * The native Problems/Output window and the main window talk over this
 * channel. The main window owns the session: it publishes what the panel
 * shows, and the satellite only ever sends intents back — reveal this
 * diagnostic, clear the log. Nothing here touches `Preferences`, so session
 * output never outlives the session.
 */
export const BOTTOM_PANEL_CHANNEL = 'shader-studio.bottom-panel';

/** At most this many diagnostics or log entries cross the channel (the log itself keeps 500). */
export const MAX_MIRRORED = 500;

export type BottomPanelMirrorTab = 'problems' | 'output';

export type BottomPanelMessage =
  | { kind: 'ready' }
  | {
      kind: 'snapshot';
      diagnostics: readonly CompileDiagnostic[];
      entries: readonly OutputLogEntry[];
    }
  | { kind: 'show'; tab: BottomPanelMirrorTab }
  | { kind: 'reveal'; docId: string; line: number }
  | { kind: 'clear-output' };

/** The main window's half: publishes the session's diagnostics and output, acts on the satellite's intents. */
@Injectable({ providedIn: 'root' })
export class BottomPanelHost {
  private readonly store = inject(ShaderStore);
  private readonly log = inject(OutputLog);
  private readonly layout = inject(SurfaceLayoutService);
  private readonly navigation = inject(EditorNavigation);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private channel: BroadcastChannel | null = null;

  start(): void {
    if (typeof BroadcastChannel === 'undefined' || this.channel) return;
    const channel = new BroadcastChannel(BOTTOM_PANEL_CHANNEL);
    this.channel = channel;
    channel.onmessage = ({ data }: MessageEvent<BottomPanelMessage>) => this.receive(data);
    this.destroyRef.onDestroy(() => {
      channel.close();
      this.channel = null;
    });

    // Only while a native window shows the panel: docked, there is nobody to tell.
    effect(
      () => {
        if (!this.layout.bottomPanelNative()) return;
        this.store.allDiagnostics();
        this.log.entries();
        untracked(() => this.publish());
      },
      { injector: this.injector },
    );
  }

  /** Brings the satellite to a tab, e.g. Problems for the toolbar's error badge. */
  show(tab: BottomPanelMirrorTab): void {
    this.post({ kind: 'show', tab });
  }

  private receive(message: BottomPanelMessage): void {
    switch (message?.kind) {
      case 'ready':
        this.publish();
        return;
      case 'clear-output':
        this.log.clear();
        return;
      case 'reveal':
        if (typeof message.docId !== 'string' || !Number.isInteger(message.line)) return;
        this.layout.openEditor();
        this.navigation.reveal(message.docId, Math.max(0, message.line));
        // Best effort: the OS may keep focus on the satellite the click came from.
        window.focus();
        return;
    }
  }

  private publish(): void {
    this.post({
      kind: 'snapshot',
      diagnostics: this.store.allDiagnostics().slice(0, MAX_MIRRORED),
      entries: this.log.entries().slice(-MAX_MIRRORED),
    });
  }

  private post(message: BottomPanelMessage): void {
    this.channel?.postMessage(message);
  }
}

/**
 * The native window's half: a read-only view of the main window's panel.
 * Without `BroadcastChannel` it simply stays empty.
 */
@Injectable({ providedIn: 'root' })
export class BottomPanelMirror {
  private readonly destroyRef = inject(DestroyRef);
  private channel: BroadcastChannel | null = null;

  readonly diagnostics = signal<readonly CompileDiagnostic[]>([]);
  readonly entries = signal<readonly OutputLogEntry[]>([]);
  /** This window's own tab; the main window only ever suggests one (`show`). */
  readonly tab = signal<BottomPanelMirrorTab>('problems');

  start(): void {
    if (typeof BroadcastChannel === 'undefined' || this.channel) return;
    const channel = new BroadcastChannel(BOTTOM_PANEL_CHANNEL);
    this.channel = channel;
    channel.onmessage = ({ data }: MessageEvent<BottomPanelMessage>) => this.receive(data);
    this.destroyRef.onDestroy(() => {
      channel.close();
      this.channel = null;
    });
    // Whatever the main window already has: it answers with a snapshot.
    this.post({ kind: 'ready' });
  }

  reveal(diagnostic: CompileDiagnostic): void {
    this.post({ kind: 'reveal', docId: diagnostic.docId ?? '', line: diagnostic.line });
  }

  clearOutput(): void {
    this.post({ kind: 'clear-output' });
  }

  private receive(message: BottomPanelMessage): void {
    if (message?.kind === 'show' && (message.tab === 'problems' || message.tab === 'output')) {
      this.tab.set(message.tab);
    }
    if (message?.kind !== 'snapshot') return;
    if (!Array.isArray(message.diagnostics) || !Array.isArray(message.entries)) return;
    this.diagnostics.set(message.diagnostics.slice(0, MAX_MIRRORED));
    this.entries.set(message.entries.slice(-MAX_MIRRORED));
  }

  private post(message: BottomPanelMessage): void {
    this.channel?.postMessage(message);
  }
}
