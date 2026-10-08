/**
 * The workspace panels — the shader browser on the left, the inspector on the
 * right — and the sanitizers that stand between their geometry and the outside
 * world.
 *
 * Kept beside `editor-prefs`, free of Angular, and for the same two reasons:
 * `Preferences` imports it to sanitize what it reads back out of `localStorage`,
 * and every value below ends up in a CSS length. A stale or hand-edited width
 * falls back to a default rather than collapsing the preview to nothing.
 */

/** Which section of the inspector is showing. */
export type InspectorTab = 'controls' | 'textures' | 'postProcessing' | 'presets';

// Same order as the inspector's tabs: the tab group reports an index.
export const INSPECTOR_TABS: readonly InspectorTab[] = [
  'controls',
  'textures',
  'postProcessing',
  'presets',
];

/**
 * How wide a panel may be dragged.
 *
 * The minima are the point at which a panel stops being able to show what it is
 * for — three inspector tabs and their counts stop fitting below about 260px.
 * The maxima stop a panel swallowing the window, but they do not by themselves
 * guarantee the preview stays dominant: both rails pulled all the way out leave
 * only 320px of a 1280px window. That is a deliberate choice the user has to
 * make with two drags. What the *defaults* guarantee is that they never have to
 * — see the spec.
 */
export const PANEL_LIMITS = {
  browserWidth: { min: 220, max: 480 },
  inspectorWidth: { min: 260, max: 480 },
} as const;

export interface PanelWidths {
  browser: number;
  inspector: number;
}

export const DEFAULT_PANEL_WIDTHS: PanelWidths = {
  browser: 300,
  inspector: 300,
};

export function clampPanelWidth(
  value: unknown,
  limits: { min: number; max: number },
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.round(Math.min(Math.max(value, limits.min), limits.max));
}

export function sanitizeInspectorTab(value: unknown): InspectorTab {
  return INSPECTOR_TABS.includes(value as InspectorTab) ? (value as InspectorTab) : 'controls';
}

/** How the shader browser lays the library out: rows, or a grid of previews. */
export type BrowserView = 'list' | 'grid';

export function sanitizeBrowserView(value: unknown): BrowserView {
  return value === 'grid' ? 'grid' : 'list';
}

// ---------------------------------------------------------------------------
// Bottom panel
// ---------------------------------------------------------------------------

/** Which tab of the bottom panel is showing. */
export type BottomPanelTab = 'problems' | 'output' | 'profiler' | 'inspection';

export const BOTTOM_PANEL_TABS: readonly BottomPanelTab[] = [
  'problems',
  'output',
  'profiler',
  'inspection',
];

/**
 * How tall the bottom panel may be dragged, in pixels.
 *
 * The maximum here is a generous absolute ceiling for what `localStorage` is
 * allowed to hold — it is not the effective limit a user actually hits while
 * dragging. That one also has to account for the workspace's current height,
 * so a panel can never swallow the whole stage; see `EditorWindow.dockedHeight`
 * for the same idea applied to the source editor.
 */
export const BOTTOM_PANEL_HEIGHT_LIMITS = { min: 120, max: 2000 } as const;

export const DEFAULT_BOTTOM_PANEL_HEIGHT = 220;
export const DEFAULT_BOTTOM_PANEL_TAB: BottomPanelTab = 'problems';
export const DEFAULT_BOTTOM_PANEL_OPEN = false;

export function sanitizeBottomPanelTab(value: unknown): BottomPanelTab {
  return BOTTOM_PANEL_TABS.includes(value as BottomPanelTab)
    ? (value as BottomPanelTab)
    : DEFAULT_BOTTOM_PANEL_TAB;
}

export function clampBottomPanelHeight(
  value: unknown,
  fallback: number = DEFAULT_BOTTOM_PANEL_HEIGHT,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.round(
    Math.min(Math.max(value, BOTTOM_PANEL_HEIGHT_LIMITS.min), BOTTOM_PANEL_HEIGHT_LIMITS.max),
  );
}

// ---------------------------------------------------------------------------
// File explorer (editor-local)
// ---------------------------------------------------------------------------

/** Which tree the editor-local explorer is showing. */
export type FileExplorerView = 'files' | 'pipeline';

export const FILE_EXPLORER_VIEW_MODES: readonly FileExplorerView[] = ['files', 'pipeline'];

export const FILE_EXPLORER_LIMITS = {
  width: { min: 180, max: 400 },
} as const;

export const DEFAULT_FILE_EXPLORER_WIDTH = 240;
export const DEFAULT_FILE_EXPLORER_OPEN = true;
export const DEFAULT_FILE_EXPLORER_VIEW: FileExplorerView = 'files';

/** Editor panel width at which the explorer switches to an overlay drawer. */
export const FILE_EXPLORER_OVERLAY_BREAKPOINT = 480;

export function sanitizeFileExplorerView(value: unknown): FileExplorerView {
  return FILE_EXPLORER_VIEW_MODES.includes(value as FileExplorerView)
    ? (value as FileExplorerView)
    : DEFAULT_FILE_EXPLORER_VIEW;
}

export function clampFileExplorerWidth(
  value: unknown,
  fallback: number = DEFAULT_FILE_EXPLORER_WIDTH,
): number {
  return clampPanelWidth(value, FILE_EXPLORER_LIMITS.width, fallback);
}
