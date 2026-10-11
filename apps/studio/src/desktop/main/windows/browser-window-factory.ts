/**
 * Shared secure BrowserWindow construction and navigation policy.
 *
 * Satellites are intentionally non-modal and do **not** set `parent`. Product
 * language may call them "child windows," but Electron parenting would make them
 * modal-ish on some platforms (minimize/close coupling) and is unnecessary for
 * ownership — the surface registry tracks SurfaceId → BrowserWindow instead.
 */

import { BrowserWindow, shell, type BrowserWindowConstructorOptions } from 'electron';

export interface SecureWebPreferences {
  preload: string;
}

export interface NavigationPolicyOptions {
  /** True when the URL may load inside this window. */
  isAppUrl: (url: string) => boolean;
  /**
   * When true, http(s) targets denied for in-window navigation are opened via
   * the OS browser. Main workspace enables this; satellites keep it false.
   */
  openExternalHttp: boolean;
}

export interface SecureWindowOptions {
  width: number;
  height: number;
  x?: number;
  y?: number;
  minWidth?: number;
  minHeight?: number;
  show?: boolean;
  frame?: boolean;
  backgroundColor?: string;
  autoHideMenuBar?: boolean;
  title?: string;
  /**
   * Only set when a platform ownership quirk truly requires it. Prefer leaving
   * undefined so satellites stay independent of the workspace window.
   */
  parent?: BrowserWindow;
  webPreferences: SecureWebPreferences;
}

const SECURE_DEFAULTS = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
} as const;

export function createSecureBrowserWindow(options: SecureWindowOptions): BrowserWindow {
  const ctor: BrowserWindowConstructorOptions = {
    width: options.width,
    height: options.height,
    x: options.x,
    y: options.y,
    minWidth: options.minWidth,
    minHeight: options.minHeight,
    show: options.show ?? false,
    // Never pass `frame: undefined`: Electron reads any present key as a boolean, so an
    // undefined frame meant a frameless window nobody could move.
    frame: options.frame ?? true,
    backgroundColor: options.backgroundColor ?? '#090b10',
    autoHideMenuBar: options.autoHideMenuBar,
    title: options.title,
    parent: options.parent,
    webPreferences: {
      preload: options.webPreferences.preload,
      ...SECURE_DEFAULTS,
    },
  };
  return new BrowserWindow(ctor);
}

/** Attach will-navigate + window-open handlers used by every app window. */
export function applyNavigationPolicy(
  window: BrowserWindow,
  policy: NavigationPolicyOptions,
): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (policy.openExternalHttp && /^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!policy.isAppUrl(url)) event.preventDefault();
  });
}

export function createAppUrlChecker(options: {
  production: boolean;
  scheme: string;
  devServerUrl: string;
}): (url: string) => boolean {
  const { production, scheme, devServerUrl } = options;
  return (url: string) =>
    production ? url.startsWith(`${scheme}://`) : url.startsWith(devServerUrl);
}

/**
 * Reject absolute URLs and path traversal. Surface bootstraps pass a pathname
 * only — never editable source or session snapshots in the query string.
 */
export function assertSafeSurfacePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) {
    throw new Error(`Surface path must be an absolute app pathname: ${path}`);
  }
  if (trimmed.includes('..') || trimmed.includes('\\')) {
    throw new Error(`Surface path must not contain traversal: ${path}`);
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    throw new Error(`Surface path must not be a URL: ${path}`);
  }
  // Allow a short query for future bootstrap tokens; reject oversized payloads.
  const q = trimmed.indexOf('?');
  if (q >= 0 && trimmed.length - q > 128) {
    throw new Error('Surface path query is too large');
  }
  return trimmed;
}
