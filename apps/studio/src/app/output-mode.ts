/**
 * True on the secondary `/output` window, which mirrors the main tab's
 * preview rather than hosting a full editing session — routing, global
 * shortcuts and startup orchestration all skip themselves there.
 */
export function isOutputWindow(): boolean {
  return typeof window !== 'undefined' && window.location.pathname.replace(/\/$/, '') === '/output';
}

/** The bottom panel's native window route: a bare app pathname, as `assertSafeSurfacePath` requires. */
export const BOTTOM_PANEL_PATH = '/bottom-panel';

/**
 * True in the desktop's native Problems/Output window. It boots its own small
 * shell instead of the workspace (see `rootComponent`), so it holds no editing
 * session and persists nothing. Desktop only: on the web the path is just an
 * unknown route, as before.
 */
export function isBottomPanelWindow(): boolean {
  return (
    typeof window !== 'undefined' &&
    'electron' in window &&
    window.location.pathname.replace(/\/$/, '') === BOTTOM_PANEL_PATH
  );
}
