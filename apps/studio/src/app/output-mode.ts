import { NATIVE_SURFACE_PATHS } from '@shadergrove/shared/surfaces';

/**
 * True on the secondary `/output` window, which mirrors the main tab's
 * preview rather than hosting a full editing session — routing, global
 * shortcuts and startup orchestration all skip themselves there.
 */
export function isOutputWindow(): boolean {
  return typeof window !== 'undefined' && window.location.pathname.replace(/\/$/, '') === '/output';
}

/** The panels the desktop can show in a native window of their own. */
export type SatelliteKind = 'bottom-panel' | 'inspector' | 'editor';

export const SATELLITE_KINDS: readonly SatelliteKind[] = ['bottom-panel', 'inspector', 'editor'];

/**
 * Which panel's native window this is, or `null` for every other window. A
 * satellite boots its own small shell instead of the workspace (see
 * `rootComponent`), so it holds no editing session and persists nothing.
 * Desktop only: on the web these paths are just unknown routes, as before.
 */
export function satelliteKind(): SatelliteKind | null {
  if (typeof window === 'undefined' || !('electron' in window)) return null;
  const pathname = window.location.pathname.replace(/\/$/, '');
  return SATELLITE_KINDS.find((kind) => NATIVE_SURFACE_PATHS[kind] === pathname) ?? null;
}

export function isSatelliteWindow(): boolean {
  return satelliteKind() !== null;
}
