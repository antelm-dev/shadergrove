import type { CompileDiagnostic } from '@shadergrove/shared/diagnostic';
import { DEFAULT_EDITOR_APPEARANCE, type EditorAppearance } from '@shadergrove/shared/editor-prefs';
import {
  DEFAULT_CHANNELS,
  type Preset,
  type RenderSettings,
  type ShaderControl,
  type ShaderParams,
  type TextureChannels,
} from '@shadergrove/shared/model';
import type { BottomPanelTab, InspectorTab } from '@shadergrove/shared/panel-prefs';
import type { SatelliteKind } from '../../output-mode';
import type { OutputLogEntry } from '../../ui/bottom-panel/output-log';
import type { InspectedShader, SystemSettings } from '../../ui/inspector/inspector-session';
import { IDLE_PROFILER, type ProfilerState } from '../../ui/inspector/profiler-session';
import type { EditorDocument } from '../state/document-state';

/**
 * The channel the main window and its native panel windows talk over.
 *
 * The main window owns the one editing session. It publishes what the panel
 * windows show (`state`), and they only ever send it commands, which it
 * validates and carries out on its own session — a panel window never
 * constructs a store, writes the library or persists preferences.
 */
export const SESSION_CHANNEL = 'shader-studio.session';

/** At most this many diagnostics or log entries cross the channel (the log itself keeps 500). */
export const MAX_MIRRORED = 500;

/** Everything a panel window may show of the main window's session. */
export interface SessionState {
  // The bottom panel.
  readonly diagnostics: readonly CompileDiagnostic[];
  readonly entries: readonly OutputLogEntry[];
  readonly bottomPanelTab: BottomPanelTab;
  readonly profiler: ProfilerState;
  // The inspector.
  readonly inspectorTab: InspectorTab;
  readonly shader: InspectedShader | null;
  readonly controls: readonly ShaderControl[];
  readonly params: ShaderParams;
  readonly channels: TextureChannels;
  readonly render: RenderSettings | null;
  readonly presets: readonly Preset[];
  readonly activePresetId: string | null;
  readonly fps: number;
  readonly system: SystemSettings;
  // The editor.
  readonly documents: readonly EditorDocument[];
  readonly activeDocId: string | null;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly editorAppearance: EditorAppearance;
}

export type SessionField = keyof SessionState;

/** What a panel window shows before the main window has answered. */
export const EMPTY_SESSION: SessionState = {
  diagnostics: [],
  entries: [],
  bottomPanelTab: 'problems',
  profiler: IDLE_PROFILER,
  inspectorTab: 'controls',
  shader: null,
  controls: [],
  params: {},
  channels: DEFAULT_CHANNELS,
  render: null,
  presets: [],
  activePresetId: null,
  fps: 0,
  system: { resolutionScale: 1, paused: false, autoRipples: false },
  documents: [],
  activeDocId: null,
  dirty: false,
  saving: false,
  editorAppearance: DEFAULT_EDITOR_APPEARANCE,
};

export const SESSION_FIELDS = Object.keys(EMPTY_SESSION) as readonly SessionField[];

/** What a panel window asks the main window to do. Every one is validated there. */
export type SessionCommand =
  // The bottom panel.
  | { readonly kind: 'reveal'; readonly docId: string; readonly line: number }
  | { readonly kind: 'clear-output' }
  | { readonly kind: 'bottom-panel-tab'; readonly tab: BottomPanelTab }
  | { readonly kind: 'apply-profiler-suggestion'; readonly scale: number }
  // The inspector.
  | { readonly kind: 'inspector-tab'; readonly tab: InspectorTab }
  | { readonly kind: 'set-param'; readonly key: string; readonly value: unknown }
  | { readonly kind: 'reset-params' }
  | { readonly kind: 'set-texture'; readonly channel: number; readonly file: File }
  | { readonly kind: 'clear-texture'; readonly channel: number }
  | { readonly kind: 'set-channel-settings'; readonly channel: number; readonly patch: unknown }
  | { readonly kind: 'set-render'; readonly render: unknown }
  | { readonly kind: 'apply-preset'; readonly presetId: string }
  | { readonly kind: 'save-preset'; readonly name: string; readonly withRender: boolean }
  | { readonly kind: 'delete-preset'; readonly presetId: string }
  | { readonly kind: 'set-system'; readonly patch: Partial<SystemSettings> }
  | { readonly kind: 'capture-image' }
  | { readonly kind: 'edit-controls' }
  // The editor.
  | {
      readonly kind: 'edit';
      /** The shader the edit was typed in: an edit never lands in another one. */
      readonly shaderId: string;
      readonly docId: string;
      /**
       * `textFingerprint` of the text the edit was typed on. The main window takes
       * the edit only while its document still has that text, so a change made
       * there in the meantime (an agent's patch, the Config builder, a newer
       * version loaded after a reload) is never overwritten.
       */
      readonly base: string;
      /** The document's whole text, so replaying an edit is harmless. */
      readonly source: string;
    }
  | { readonly kind: 'select-doc'; readonly docId: string }
  | { readonly kind: 'save' };

export type SessionCommandKind = SessionCommand['kind'];

/**
 * Commands that are safe to send again after the main window restarted
 * without answering them: each sets a value rather than doing something.
 */
export const REPLAYABLE_COMMANDS: ReadonlySet<SessionCommandKind> = new Set<SessionCommandKind>([
  'edit',
  'select-doc',
  'set-param',
  'set-render',
  'set-system',
  'bottom-panel-tab',
  'inspector-tab',
]);

/** Why the main window refused a command; a panel window says so. */
export type SessionRefusal =
  /** The document changed in the main window since the edit was typed. */
  | 'conflict'
  | 'too-large'
  /** The main window has another shader open (or none). */
  | 'other-shader'
  | 'invalid'
  /** Accepted, but failed (a save that did not go through). */
  | 'failed';

export type SessionMessage =
  // Main window → panel windows.
  /**
   * The main window (re)started; `ready` once its session has settled: a shader
   * loaded and no draft-recovery question pending (or, failing that, a few seconds).
   */
  | { readonly kind: 'host'; readonly ready: boolean }
  | { readonly kind: 'state'; readonly patch: Partial<SessionState> }
  /**
   * A command was carried out (`ok`) or refused (`reason`). A refusal follows
   * the main window's whole state, so the panel window drops what it showed
   * ahead of the answer.
   */
  | {
      readonly kind: 'done';
      readonly client: string;
      readonly seq: number;
      readonly ok: boolean;
      readonly reason?: SessionRefusal;
    }
  /** Show a line in the detached editor, e.g. for a diagnostic clicked anywhere. */
  | { readonly kind: 'reveal-in-editor'; readonly docId: string; readonly line: number }
  // Panel windows → main window.
  /** `window` says which panel's window it is, so what waits for that window can follow. */
  | { readonly kind: 'hello'; readonly client: string; readonly window?: SatelliteKind }
  | {
      readonly kind: 'command';
      readonly client: string;
      readonly seq: number;
      readonly command: SessionCommand;
    };

const OUTPUT_LEVELS: ReadonlySet<string> = new Set(['info', 'warning', 'error']);
const OUTPUT_SOURCES: ReadonlySet<string> = new Set(['compiler', 'renderer', 'workspace', 'mcp']);

/**
 * The fields of a `state` patch a panel window may take: known names whose
 * value has the shape of the empty state's, and only log entries it can show.
 */
export function acceptPatch(patch: unknown): Partial<SessionState> {
  if (!patch || typeof patch !== 'object') return {};
  const accepted: Partial<Record<SessionField, unknown>> = {};
  for (const field of SESSION_FIELDS) {
    if (!Object.hasOwn(patch, field)) continue;
    const value = (patch as Record<string, unknown>)[field];
    if (!sameShape(EMPTY_SESSION[field], value, field)) continue;
    accepted[field] =
      field === 'entries'
        ? (value as OutputLogEntry[])
            .filter(
              (entry) =>
                !!entry &&
                OUTPUT_LEVELS.has(entry.level) &&
                OUTPUT_SOURCES.has(entry.source) &&
                typeof entry.message === 'string',
            )
            .slice(-MAX_MIRRORED)
        : field === 'diagnostics'
          ? (value as CompileDiagnostic[]).slice(0, MAX_MIRRORED)
          : value;
  }
  return accepted as Partial<SessionState>;
}

/** Nullable fields take `null` or an object; the rest keep their empty value's type. */
const NULLABLE: ReadonlySet<SessionField> = new Set<SessionField>([
  'shader',
  'render',
  'activePresetId',
  'activeDocId',
]);

function sameShape(empty: unknown, value: unknown, field: SessionField): boolean {
  if (value === null) return NULLABLE.has(field);
  if (Array.isArray(empty)) return Array.isArray(value);
  if (NULLABLE.has(field)) {
    return field === 'activePresetId' || field === 'activeDocId'
      ? typeof value === 'string'
      : typeof value === 'object' && !Array.isArray(value);
  }
  return typeof value === typeof empty && Array.isArray(value) === Array.isArray(empty);
}

/**
 * A short, stable stand-in for a document's text (length and FNV-1a hash), so
 * an edit can name the text it was typed on without sending it twice.
 */
export function textFingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}
