import {
  DestroyRef,
  Injectable,
  Injector,
  computed,
  effect,
  inject,
  signal,
  untracked,
  type Signal,
} from '@angular/core';

import { BOTTOM_PANEL_TABS, INSPECTOR_TABS } from '@shadergrove/shared/panel-prefs';
import type { ChannelIndex } from '@shadergrove/shared/project';
import {
  LIMITS,
  validateChannelSettingsPatch,
  validateParamValue,
  validateRenderStrict,
} from '@shadergrove/shared/validate';
import { EditorNavigation, resolveNavigationTarget } from '../../editor/editor-navigation';
import { EditorSettings } from '../../editor/editor-settings';
import { Preferences } from '../../prefs/preferences';
import { SurfaceLayoutService } from '../../surfaces/surface-layout';
import { OutputLog } from '../../ui/bottom-panel/output-log';
import {
  WorkspaceInspectorSession,
  type SystemSettings,
} from '../../ui/inspector/inspector-session';
import { IDLE_PROFILER, ProfilerSession } from '../../ui/inspector/profiler-session';
import { ShaderStore } from '../shader-store';
import {
  MAX_MIRRORED,
  SESSION_CHANNEL,
  SESSION_FIELDS,
  type SessionCommand,
  type SessionField,
  type SessionMessage,
  type SessionState,
} from './session-protocol';

/** The System folder's resolution scale range. */
const SCALE_RANGE = { min: 0.25, max: 2 } as const;

/**
 * The main window's half of the session channel: it publishes its session to
 * the native panel windows and carries out what they ask, after checking it.
 *
 * Every command is answered with `done` only once the state it changed has
 * been posted, so a panel window that changed something ahead of the answer
 * never sees an older value come back after its own.
 */
@Injectable({ providedIn: 'root' })
export class SessionHost {
  private readonly store = inject(ShaderStore);
  private readonly log = inject(OutputLog);
  private readonly layout = inject(SurfaceLayoutService);
  private readonly navigation = inject(EditorNavigation);
  private readonly preferences = inject(Preferences);
  private readonly settings = inject(EditorSettings);
  private readonly inspector = inject(WorkspaceInspectorSession);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);

  private channel: BroadcastChannel | null = null;
  /**
   * The bottom panel's Profiler tab, profiled here while its window shows it.
   * Created the first time the panel is detached: before that, the docked
   * panel's own session is the only one, and nothing here may switch it off.
   */
  private readonly profiler = signal<ProfilerSession | null>(null);
  /** What each field was when last posted: a flush posts only what changed. */
  private readonly posted = new Map<SessionField, unknown>();
  private sources: { readonly [K in SessionField]: Signal<SessionState[K]> } | null = null;

  start(): void {
    if (typeof BroadcastChannel === 'undefined' || this.channel) return;
    const channel = new BroadcastChannel(SESSION_CHANNEL);
    this.channel = channel;
    channel.onmessage = ({ data }: MessageEvent<SessionMessage>) => this.receive(data);
    this.destroyRef.onDestroy(() => {
      channel.close();
      this.channel = null;
    });

    const profiling = computed(() => {
      const { bottomPanelOpen, bottomPanelTab } = this.preferences.value();
      return this.layout.bottomPanelNative() && bottomPanelOpen && bottomPanelTab === 'profiler';
    });
    const profile = effect(
      () => {
        if (!this.layout.bottomPanelNative()) return;
        untracked(() => this.profiler.set(new ProfilerSession(profiling, this.injector)));
        profile.destroy();
      },
      { injector: this.injector },
    );
    this.sources = this.createSources();

    // Only while a panel is detached: docked, there is nobody to tell.
    effect(
      () => {
        if (!this.layout.anyNative()) return;
        for (const field of SESSION_FIELDS) this.sources![field]();
        untracked(() => this.flush());
      },
      { injector: this.injector },
    );

    // A reload of this window leaves the panel windows open: they say hello again, and once
    // the session is back they resend what this window never confirmed.
    this.post({ kind: 'host', ready: false });
    const ready = computed(() => !this.store.loading() && this.store.record() !== null);
    const announce = effect(
      () => {
        if (!ready()) return;
        untracked(() => this.post({ kind: 'host', ready: true }));
        announce.destroy();
      },
      { injector: this.injector },
    );

    this.forwardEditorReveals();
  }

  private createSources(): {
    readonly [K in SessionField]: Signal<SessionState[K]>;
  } {
    const store = this.store;
    const inspector = this.inspector;
    return {
      diagnostics: computed(() => store.allDiagnostics().slice(0, MAX_MIRRORED)),
      entries: computed(() => this.log.entries().slice(-MAX_MIRRORED)),
      bottomPanelTab: computed(() => this.preferences.value().bottomPanelTab),
      profiler: computed(() => this.profiler()?.state() ?? IDLE_PROFILER),
      inspectorTab: inspector.tab,
      shader: inspector.shader,
      controls: inspector.controls,
      params: inspector.params,
      channels: inspector.channels,
      render: inspector.render,
      presets: inspector.presets,
      activePresetId: inspector.activePresetId,
      fps: inspector.fps,
      system: inspector.system,
      documents: store.documents,
      activeDocId: computed(() => store.activeDoc()?.id ?? null),
      dirty: store.dirty,
      saving: computed(() => store.saving()),
      editorAppearance: this.settings.effective,
    };
  }

  /** Posts every field that changed since it was last posted. */
  private flush(all = false): void {
    const sources = this.sources;
    if (!sources) return;
    const patch: Partial<Record<SessionField, unknown>> = {};
    let changed = false;
    for (const field of SESSION_FIELDS) {
      const value = sources[field]();
      if (!all && Object.is(this.posted.get(field), value)) continue;
      this.posted.set(field, value);
      patch[field] = value;
      changed = true;
    }
    if (changed) this.post({ kind: 'state', patch: patch as Partial<SessionState> });
  }

  /**
   * While the editor is detached, a reveal asked for anywhere — a diagnostic in
   * the docked panel, the Config from the inspector — goes to its window.
   */
  private forwardEditorReveals(): void {
    effect(
      () => {
        const request = this.navigation.request();
        if (!request || !this.layout.editorNative()) return;
        untracked(() => {
          const target = resolveNavigationTarget(
            request,
            this.store.documents().map((document) => document.id),
            this.store.activeDoc()?.id ?? null,
          );
          // Consumed here: no docked editor will replay it later.
          this.navigation.request.set(null);
          if (!target) return;
          this.store.selectDoc(target.docId);
          this.flush();
          this.post({ kind: 'reveal-in-editor', docId: target.docId, line: target.line });
        });
      },
      { injector: this.injector },
    );
  }

  private receive(message: SessionMessage): void {
    switch (message?.kind) {
      case 'hello':
        this.flush(true);
        return;
      case 'command':
        if (typeof message.client !== 'string' || !Number.isInteger(message.seq)) return;
        void this.answer(message.client, message.seq, message.command);
        return;
    }
  }

  private async answer(client: string, seq: number, command: SessionCommand): Promise<void> {
    let ok = false;
    try {
      ok = await this.run(command);
    } catch {
      ok = false;
    }
    // What the command changed goes out first: see the class comment.
    this.flush();
    this.post({ kind: 'done', client, seq, ok });
  }

  /** Carries out one command on this window's session; `false` when refused. */
  private run(command: SessionCommand): boolean | Promise<boolean> {
    switch (command?.kind) {
      case 'reveal': {
        if (typeof command.docId !== 'string' || !Number.isInteger(command.line)) return false;
        this.layout.openEditor();
        this.navigation.reveal(command.docId, Math.max(0, command.line));
        // Best effort: the OS may keep focus on the window the click came from.
        window.focus();
        return true;
      }
      case 'clear-output':
        this.log.clear();
        return true;
      case 'bottom-panel-tab':
        if (!BOTTOM_PANEL_TABS.includes(command.tab)) return false;
        this.preferences.patch({ bottomPanelTab: command.tab });
        return true;
      case 'apply-profiler-suggestion': {
        // Only what the profiler itself proposed: a panel window cannot pick any scale.
        const profiler = this.profiler();
        const suggestion = profiler?.state().suggestion;
        if (suggestion === null || suggestion === undefined || command.scale !== suggestion) {
          return false;
        }
        profiler?.applySuggestion(suggestion);
        return true;
      }
      case 'inspector-tab':
        if (!INSPECTOR_TABS.includes(command.tab)) return false;
        this.layout.setInspectorTab(command.tab);
        return true;
      case 'set-param': {
        const control = this.store.controls().find((item) => item.key === command.key);
        const value = control ? validateParamValue(control, command.value) : null;
        if (!value?.ok) return false;
        this.store.setParam(command.key, value.value);
        return true;
      }
      case 'reset-params':
        this.store.resetParams();
        return true;
      case 'set-texture': {
        const channel = channelIndex(command.channel);
        if (channel === null || !(command.file instanceof Blob)) return false;
        return this.store.setTextureImage(channel, command.file as File).then(() => true);
      }
      case 'clear-texture': {
        const channel = channelIndex(command.channel);
        if (channel === null) return false;
        return this.store.clearTextureImage(channel).then(() => true);
      }
      case 'set-channel-settings': {
        const channel = channelIndex(command.channel);
        const patch = validateChannelSettingsPatch([command.patch])[0];
        if (channel === null || !patch || Object.keys(patch).length === 0) return false;
        return this.store.setChannelSettings(channel, patch).then(() => true);
      }
      case 'set-render': {
        const render = validateRenderStrict(command.render);
        if (!render.ok) return false;
        this.store.setRender(render.value);
        return true;
      }
      case 'apply-preset':
        if (!this.store.presets().some((preset) => preset.id === command.presetId)) return false;
        this.store.applyPreset(command.presetId);
        return true;
      case 'save-preset': {
        const name = typeof command.name === 'string' ? command.name.trim() : '';
        if (!name || name.length > LIMITS.nameLength || typeof command.withRender !== 'boolean') {
          return false;
        }
        return this.store.savePreset(name, command.withRender).then(() => true);
      }
      case 'delete-preset':
        if (!this.store.presets().some((preset) => preset.id === command.presetId)) return false;
        return this.store.deletePreset(command.presetId).then(() => true);
      case 'set-system': {
        const patch = systemPatch(command.patch);
        if (!patch) return false;
        this.preferences.patch(patch);
        return true;
      }
      case 'capture-image':
        return this.inspector.captureImage().then(() => true);
      case 'edit-controls':
        this.inspector.editControls();
        return true;
      case 'edit': {
        // The shader the edit was typed in, and a document it still has: never another's.
        if (
          typeof command.source !== 'string' ||
          command.source.length > LIMITS.sourceLength ||
          command.shaderId !== this.store.record()?.id ||
          !this.store.documents().some((document) => document.id === command.docId)
        ) {
          return false;
        }
        this.store.setDocSource(command.docId, command.source);
        return true;
      }
      case 'select-doc':
        if (!this.store.documents().some((document) => document.id === command.docId)) {
          return false;
        }
        this.store.selectDoc(command.docId);
        return true;
      case 'save':
        return this.store.save();
      default:
        return false;
    }
  }

  private post(message: SessionMessage): void {
    this.channel?.postMessage(message);
  }
}

function channelIndex(value: unknown): ChannelIndex | null {
  return value === 0 || value === 1 || value === 2 || value === 3 ? value : null;
}

/** The System settings a panel window may change, checked one by one; `null` when none is valid. */
function systemPatch(input: unknown): Partial<SystemSettings> | null {
  if (!input || typeof input !== 'object') return null;
  const { resolutionScale, paused, autoRipples } = input as Record<string, unknown>;
  const patch: { -readonly [K in keyof SystemSettings]?: SystemSettings[K] } = {};
  if (
    typeof resolutionScale === 'number' &&
    Number.isFinite(resolutionScale) &&
    resolutionScale >= SCALE_RANGE.min &&
    resolutionScale <= SCALE_RANGE.max
  ) {
    patch.resolutionScale = resolutionScale;
  }
  if (typeof paused === 'boolean') patch.paused = paused;
  if (typeof autoRipples === 'boolean') patch.autoRipples = autoRipples;
  return Object.keys(patch).length > 0 ? patch : null;
}
