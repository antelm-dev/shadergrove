import { DOCUMENT, Injectable, PLATFORM_ID, computed, effect, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

import { DEFAULT_CAPTURE, type CaptureSettings } from '@shadergrove/shared/model';
import { normalizeCapture } from '@shadergrove/shared/capture-plan';
import {
  DEFAULT_EDITOR_APPEARANCE,
  DEFAULT_EDITOR_WINDOW,
  sanitizeAppearance,
  sanitizeWindowState,
  type EditorAppearance,
  type EditorWindowState,
} from '@shadergrove/shared/editor-prefs';
import {
  DEFAULT_BOTTOM_PANEL_HEIGHT,
  DEFAULT_BOTTOM_PANEL_OPEN,
  DEFAULT_BOTTOM_PANEL_TAB,
  DEFAULT_FILE_EXPLORER_OPEN,
  DEFAULT_FILE_EXPLORER_VIEW,
  DEFAULT_FILE_EXPLORER_WIDTH,
  DEFAULT_PANEL_WIDTHS,
  PANEL_LIMITS,
  clampBottomPanelHeight,
  clampFileExplorerWidth,
  clampPanelWidth,
  sanitizeBottomPanelTab,
  sanitizeBrowserView,
  sanitizeFileExplorerView,
  sanitizeInspectorTab,
  type BottomPanelTab,
  type BrowserView,
  type FileExplorerView,
  type InspectorTab,
} from '@shadergrove/shared/panel-prefs';
import {
  DEFAULT_PREVIEW_WINDOW,
  sanitizePreviewWindow,
  type PreviewWindowState,
} from '@shadergrove/shared/preview-prefs';
import {
  DEFAULT_EDITOR_GROUP_ID,
  WELL_KNOWN_SURFACE_IDS,
  editorSurfaceId,
  migrateLayoutFromPreferences,
  type LayoutPreferences,
} from '@shadergrove/shared/surfaces';
import {
  DEFAULT_APP_THEME_ID,
  canonicalLocale,
  sanitizeAppThemeId,
  sanitizeAppThemeMode,
  sanitizeLanguagePackId,
  type AppThemeId,
  type AppThemeMode,
  type LanguagePackId,
} from '@shadergrove/shared/plugin';

/**
 * UI state that should survive a reload: which shader was open, which panels
 * were showing, how hard the GPU was being pushed, and how the source editor is
 * dressed and arranged.
 *
 * Kept deliberately separate from the shader documents themselves — this is
 * about the workspace, not the content, and it never leaves the browser.
 *
 * On the server every value stays at its default, which is also what the very
 * first client render uses, so hydration matches.
 */

const STORAGE_KEY = 'shader-studio.preferences';

export const COLOR_SCHEME_OPTIONS = [
  { value: 'light', label: 'Light', icon: 'light_mode' },
  { value: 'dark', label: 'Dark', icon: 'dark_mode' },
  { value: 'system', label: 'System', icon: 'contrast' },
] as const;

export type ColorScheme = (typeof COLOR_SCHEME_OPTIONS)[number]['value'];
export type ResolvedColorScheme = Exclude<ColorScheme, 'system'>;

export function colorSchemeIcon(scheme: ColorScheme): string {
  return COLOR_SCHEME_OPTIONS.find((option) => option.value === scheme)?.icon ?? 'dark_mode';
}

export interface WorkspacePreferences {
  /**
   * The locale of the language last worn, as a canonical BCP 47 tag. What an
   * older release of the app reads; `languagePackId` is what this one chooses by.
   */
  language: string;
  /**
   * The language chosen: a language contribution by reference, `fallback-en`,
   * or `null` for a preference from before languages were packages, which is
   * migrated once from `language`. Only a reference: whether that language is
   * installed is the i18n service's question.
   */
  languagePackId: LanguagePackId;
  lastShaderId: string | null;
  /** Remembered so importing from Shadertoy doesn't ask for it every time. */
  shadertoyApiKey: string | null;
  browserOpen: boolean;
  editorOpen: boolean;
  /** Whether the inspector rail is showing. Toggled by the H shortcut. */
  guiVisible: boolean;
  /** Width of the shader browser, in pixels. */
  browserWidth: number;
  /** Rows, or a grid of previews, in the shader browser. */
  browserView: BrowserView;
  /** Width of the inspector rail, in pixels. */
  inspectorWidth: number;
  /** Which inspector tab was last open. */
  inspectorTab: InspectorTab;
  /** Whether the bottom panel (Problems / Output) is showing. */
  bottomPanelOpen: boolean;
  /** Height of the bottom panel, in pixels. */
  bottomPanelHeight: number;
  /** Which bottom panel tab was last open. */
  bottomPanelTab: BottomPanelTab;
  /** Whether the editor-local file explorer column is showing. */
  fileExplorerOpen: boolean;
  /** Files or Pipeline view in the editor-local explorer. */
  fileExplorerView: FileExplorerView;
  /** Width of the editor-local explorer, in pixels. */
  fileExplorerWidth: number;
  resolutionScale: number;
  paused: boolean;
  autoRipples: boolean;
  /**
   * The fallback palette's scheme: what is painted while the chosen theme is
   * not available (not loaded yet, switched off, removed). Kept in step with
   * the theme worn, so the fallback looks like it.
   */
  colorScheme: ColorScheme;
  /**
   * A reference to a plugin theme, or `builtin` until a legacy preference is
   * migrated. Only a reference: whether that theme is installed is the theme
   * service's question, not this one's.
   */
  appThemeId: AppThemeId;
  /** Wear `appThemeId` as is, or its pair's variant for the OS's light/dark setting. */
  appThemeMode: AppThemeMode;
  /** How the editor is dressed: font, size, theme, and the rest. */
  editorAppearance: EditorAppearance;
  /** Where the editor sits: docked, floating, maximized or collapsed. */
  editorWindow: EditorWindowState;
  /** Where the preview sits: the stage, or a window over it. @deprecated use surfacesLayout */
  previewWindow: PreviewWindowState;
  /** Versioned contained/native surface layout (Agent 06). */
  surfacesLayout: LayoutPreferences;
  /**
   * What the last export was set to. A capture is a form with eight fields, and
   * nobody fills it in twice — an export is almost always a re-export at a
   * slightly different length.
   */
  capture: CaptureSettings;
}

const DEFAULTS: WorkspacePreferences = {
  language: 'en',
  languagePackId: null,
  lastShaderId: null,
  shadertoyApiKey: null,
  browserOpen: true,
  editorOpen: false,
  guiVisible: true,
  browserWidth: DEFAULT_PANEL_WIDTHS.browser,
  browserView: 'list',
  inspectorWidth: DEFAULT_PANEL_WIDTHS.inspector,
  inspectorTab: 'controls',
  bottomPanelOpen: DEFAULT_BOTTOM_PANEL_OPEN,
  bottomPanelHeight: DEFAULT_BOTTOM_PANEL_HEIGHT,
  bottomPanelTab: DEFAULT_BOTTOM_PANEL_TAB,
  fileExplorerOpen: DEFAULT_FILE_EXPLORER_OPEN,
  fileExplorerView: DEFAULT_FILE_EXPLORER_VIEW,
  fileExplorerWidth: DEFAULT_FILE_EXPLORER_WIDTH,
  resolutionScale: 1,
  paused: false,
  autoRipples: false,
  colorScheme: 'dark',
  appThemeId: DEFAULT_APP_THEME_ID,
  appThemeMode: 'fixed',
  editorAppearance: DEFAULT_EDITOR_APPEARANCE,
  editorWindow: DEFAULT_EDITOR_WINDOW,
  previewWindow: DEFAULT_PREVIEW_WINDOW,
  surfacesLayout: migrateLayoutFromPreferences({
    editorOpen: false,
    editorWindow: DEFAULT_EDITOR_WINDOW,
    previewWindow: DEFAULT_PREVIEW_WINDOW,
    browserOpen: true,
    guiVisible: true,
    browserWidth: DEFAULT_PANEL_WIDTHS.browser,
    inspectorWidth: DEFAULT_PANEL_WIDTHS.inspector,
    bottomPanelOpen: DEFAULT_BOTTOM_PANEL_OPEN,
    bottomPanelHeight: DEFAULT_BOTTOM_PANEL_HEIGHT,
  }),
  capture: DEFAULT_CAPTURE,
};

function sanitizeColorScheme(value: unknown): ColorScheme {
  return COLOR_SCHEME_OPTIONS.some((option) => option.value === value)
    ? (value as ColorScheme)
    : DEFAULTS.colorScheme;
}

/** The appearance every window of the app shares: what it is painted with, and what it says. */
const SHARED_KEYS = [
  'appThemeId',
  'appThemeMode',
  'colorScheme',
  'language',
  'languagePackId',
] as const satisfies readonly (keyof WorkspacePreferences)[];

export function createDefaultWorkspacePreferences(): WorkspacePreferences {
  return { ...DEFAULTS };
}

/** Any canonical locale an older or newer release stored; anything else is English. */
function sanitizeLanguage(value: unknown): string {
  return canonicalLocale(value) ?? 'en';
}

@Injectable({ providedIn: 'root' })
export class Preferences {
  private readonly document = inject(DOCUMENT);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  private readonly state = signal<WorkspacePreferences>(DEFAULTS);
  private readonly systemDark = signal(true);

  readonly value = this.state.asReadonly();

  /** The OS's light/dark setting, whatever is chosen. */
  readonly systemScheme = computed<ResolvedColorScheme>(() =>
    this.systemDark() ? 'dark' : 'light',
  );

  /**
   * The light/dark scheme of the fallback palette: the OS's when the preference
   * is `system`, otherwise the preference itself. A theme brings its own
   * scheme — `AppThemes.scheme` is the one actually painted.
   */
  readonly resolved = computed<ResolvedColorScheme>(() => {
    const scheme = this.state().colorScheme;
    return scheme === 'system' ? this.systemScheme() : scheme;
  });

  constructor() {
    if (this.isBrowser) {
      this.state.set(this.load());

      const query = this.document.defaultView?.matchMedia('(prefers-color-scheme: dark)');
      if (query) {
        this.systemDark.set(query.matches);
        query.addEventListener('change', (event) => this.systemDark.set(event.matches));
      }

      effect(() => this.persist(this.state()));

      // Another window of the app saved its preferences: wear the same theme and speak the
      // same language here. Layout and the rest stay this window's own.
      this.document.defaultView?.addEventListener?.('storage', (event) => {
        if (event.key !== STORAGE_KEY || event.newValue === null) return;
        const saved = this.load();
        this.patch(Object.fromEntries(SHARED_KEYS.map((key) => [key, saved[key]])));
      });
    }
  }

  patch(patch: Partial<WorkspacePreferences>): void {
    this.state.update((current) => ({ ...current, ...patch }));
  }

  private get storage(): Storage | null {
    try {
      // Private-browsing modes expose `localStorage` but throw on access.
      return this.document.defaultView?.localStorage ?? null;
    } catch {
      return null;
    }
  }

  private load(): WorkspacePreferences {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      if (!raw) return DEFAULTS;

      const parsed = JSON.parse(raw) as Partial<WorkspacePreferences>;
      const editorWindow = sanitizeWindowState(parsed.editorWindow);
      const previewWindow = sanitizePreviewWindow(parsed.previewWindow);
      const browserOpen = parsed.browserOpen ?? DEFAULTS.browserOpen;
      const editorOpenLegacy = parsed.editorOpen ?? DEFAULTS.editorOpen;
      const guiVisible = parsed.guiVisible ?? DEFAULTS.guiVisible;
      const browserWidth = clampPanelWidth(
        parsed.browserWidth,
        PANEL_LIMITS.browserWidth,
        DEFAULTS.browserWidth,
      );
      const inspectorWidth = clampPanelWidth(
        parsed.inspectorWidth,
        PANEL_LIMITS.inspectorWidth,
        DEFAULTS.inspectorWidth,
      );
      const bottomPanelOpen =
        typeof parsed.bottomPanelOpen === 'boolean'
          ? parsed.bottomPanelOpen
          : DEFAULTS.bottomPanelOpen;
      const bottomPanelHeight = clampBottomPanelHeight(
        parsed.bottomPanelHeight,
        DEFAULTS.bottomPanelHeight,
      );

      const surfacesLayout = migrateLayoutFromPreferences({
        ...parsed,
        editorOpen: editorOpenLegacy,
        editorWindow,
        previewWindow,
        browserOpen,
        guiVisible,
        browserWidth,
        inspectorWidth,
        bottomPanelOpen,
        bottomPanelHeight,
        bottomPanelTab: parsed.bottomPanelTab,
        inspectorTab: parsed.inspectorTab,
      });

      const editorSurface = surfacesLayout.surfaces.find(
        (surface) => surface.id === editorSurfaceId(DEFAULT_EDITOR_GROUP_ID),
      );
      const editorOpen = editorSurface?.open ?? editorOpenLegacy;

      // The inspector surface is the durable source once migrated — mirror it
      // back onto the legacy fields so code that still reads `guiVisible` /
      // `inspectorTab` directly (e.g. the profiler tab) sees the same state.
      const inspectorSurface = surfacesLayout.surfaces.find(
        (surface) => surface.id === WELL_KNOWN_SURFACE_IDS.inspector,
      );
      const resolvedGuiVisible = inspectorSurface?.open ?? guiVisible;
      const resolvedInspectorTab =
        inspectorSurface?.chrome.kind === 'inspector'
          ? inspectorSurface.chrome.tab
          : sanitizeInspectorTab(parsed.inspectorTab);

      return {
        language: sanitizeLanguage(parsed.language),
        languagePackId: sanitizeLanguagePackId(parsed.languagePackId),
        lastShaderId:
          typeof parsed.lastShaderId === 'string' ? parsed.lastShaderId : DEFAULTS.lastShaderId,
        shadertoyApiKey:
          typeof parsed.shadertoyApiKey === 'string'
            ? parsed.shadertoyApiKey
            : DEFAULTS.shadertoyApiKey,
        browserOpen,
        editorOpen,
        guiVisible: resolvedGuiVisible,
        browserWidth,
        browserView: sanitizeBrowserView(parsed.browserView),
        inspectorWidth,
        inspectorTab: resolvedInspectorTab,
        bottomPanelOpen,
        bottomPanelHeight,
        bottomPanelTab: sanitizeBottomPanelTab(parsed.bottomPanelTab),
        fileExplorerOpen:
          typeof parsed.fileExplorerOpen === 'boolean'
            ? parsed.fileExplorerOpen
            : DEFAULTS.fileExplorerOpen,
        fileExplorerView: sanitizeFileExplorerView(parsed.fileExplorerView),
        fileExplorerWidth: clampFileExplorerWidth(
          parsed.fileExplorerWidth,
          DEFAULTS.fileExplorerWidth,
        ),
        resolutionScale:
          typeof parsed.resolutionScale === 'number' &&
          parsed.resolutionScale >= 0.25 &&
          parsed.resolutionScale <= 2
            ? parsed.resolutionScale
            : DEFAULTS.resolutionScale,
        paused: parsed.paused ?? DEFAULTS.paused,
        autoRipples: parsed.autoRipples ?? DEFAULTS.autoRipples,
        colorScheme: sanitizeColorScheme(parsed.colorScheme),
        appThemeId: sanitizeAppThemeId(parsed.appThemeId),
        appThemeMode: sanitizeAppThemeMode(parsed.appThemeMode),
        editorAppearance: sanitizeAppearance(parsed.editorAppearance),
        editorWindow,
        previewWindow,
        surfacesLayout,
        capture: normalizeCapture(parsed.capture),
      };
    } catch {
      return DEFAULTS;
    }
  }

  private persist(value: WorkspacePreferences): void {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(value));
    } catch {
      // A full or unavailable quota must never break the app.
    }
  }
}
