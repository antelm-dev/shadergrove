import { BrowserWindow, shell } from 'electron';
import {
  createIpcEmitter,
  defineIpcEvents,
  defineIpcModule,
  handle,
  listen,
} from 'electron-ipc-module';

import type {
  NativeSurfaceChangedEvent,
  NativeSurfaceContext,
  NativeSurfaceOpenRequest,
  NativeSurfaceResult,
  NativeSurfaceSnapshot,
} from '../../contracts/contracts';

import type { SurfaceWindowManager } from '../windows/surface-window-manager';
import { resolveSupportLinkUrl } from './support-links';

type WindowEvents = {
  'close-requested': [];
  'state-changed': [state: { maximized: boolean; fullscreen: boolean }];
  /** @deprecated Prefer surface-changed; kept for live-preview-output adapter. */
  'output-state-changed': [open: boolean];
  'surface-changed': [event: NativeSurfaceChangedEvent];
  'surface-returned': [payload: { surfaceId: string; kind: string }];
};
export const windowEvents = defineIpcEvents<WindowEvents>();
export const windowEmitter = createIpcEmitter<WindowEvents>('window');

export interface CloseController {
  approved: WeakSet<BrowserWindow>;
  /** Legacy open-output adapter — delegates to SurfaceWindowManager. */
  openOutput: (sender: BrowserWindow) => void;
  closeOutput: () => void;
  outputOpen: () => boolean;
  /** Generic surface manager (Agent 04). Required once main wires it. */
  surfaces?: SurfaceWindowManager;
  getMainWindow?: () => BrowserWindow | null;
}

function requireSurfaces(controller: CloseController): SurfaceWindowManager | null {
  return controller.surfaces ?? null;
}

function senderWindow(event: { sender: Electron.WebContents }): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

function reject(reason: string): NativeSurfaceResult {
  return { status: 'rejected', reason };
}

export function createWindowIpc(controller: CloseController) {
  return defineIpcModule(
    'window',
    {
      minimize: listen((event) => BrowserWindow.fromWebContents(event.sender)?.minimize()),
      'toggle-maximize': listen((event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win?.isMaximized()) win.unmaximize();
        else win?.maximize();
      }),
      'toggle-fullscreen': listen((event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win) win.setFullScreen(!win.isFullScreen());
      }),
      'toggle-devtools': listen((event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win || win.isDestroyed()) return;
        const contents = win.webContents;
        if (contents.isDestroyed()) return;
        if (contents.isDevToolsOpened()) contents.closeDevTools();
        else contents.openDevTools();
      }),
      state: handle((event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        return { maximized: win?.isMaximized() ?? false, fullscreen: win?.isFullScreen() ?? false };
      }),
      'open-output': listen((event) => {
        const sender = BrowserWindow.fromWebContents(event.sender);
        if (sender) controller.openOutput(sender);
      }),
      'close-output': listen(() => controller.closeOutput()),
      'output-open': handle(() => controller.outputOpen()),
      close: listen((event) => BrowserWindow.fromWebContents(event.sender)?.close()),
      'approve-close': listen((event, approved: boolean) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win || !approved) return;
        controller.approved.add(win);
        win.close();
      }),
      /**
       * Open or focus a native surface. Main workspace only.
       * Closing never discards drafts — only the BrowserWindow.
       */
      'surface-open': handle(
        async (event, request: NativeSurfaceOpenRequest): Promise<NativeSurfaceResult> => {
          const surfaces = requireSurfaces(controller);
          const sender = senderWindow(event);
          if (!surfaces || !sender) return reject('unavailable');
          const auth = surfaces.authorize(sender, 'open');
          if (!auth.allowed) return reject(auth.reason);
          return surfaces.open(request);
        },
      ),

      'surface-focus': handle((event, surfaceId: string): NativeSurfaceResult => {
        const surfaces = requireSurfaces(controller);
        const sender = senderWindow(event);
        if (!surfaces || !sender) return reject('unavailable');
        const auth = surfaces.authorize(sender, 'focus', surfaceId);
        if (!auth.allowed) return reject(auth.reason);
        return surfaces.focus(surfaceId);
      }),

      'surface-close': handle((event, surfaceId?: string): NativeSurfaceResult => {
        const surfaces = requireSurfaces(controller);
        const sender = senderWindow(event);
        if (!surfaces || !sender) return reject('unavailable');
        const auth = surfaces.authorize(sender, 'close', surfaceId);
        if (!auth.allowed) return reject(auth.reason);
        const ctx = surfaces.getContextForSender(sender);
        const target = surfaceId || (ctx.role === 'satellite' ? ctx.surfaceId : '');
        if (!target) return reject('missing-surface-id');
        return surfaces.close(target);
      }),

      'surface-return': handle((event, surfaceId?: string): NativeSurfaceResult => {
        const surfaces = requireSurfaces(controller);
        const sender = senderWindow(event);
        if (!surfaces || !sender) return reject('unavailable');
        const auth = surfaces.authorize(sender, 'return', surfaceId);
        if (!auth.allowed) return reject(auth.reason);
        const ctx = surfaces.getContextForSender(sender);
        const target = surfaceId || (ctx.role === 'satellite' ? ctx.surfaceId : '');
        if (!target) return reject('missing-surface-id');
        return surfaces.returnToWorkspace(target);
      }),

      'surface-list': handle((event): NativeSurfaceSnapshot[] => {
        const surfaces = requireSurfaces(controller);
        const sender = senderWindow(event);
        if (!surfaces || !sender) return [];
        const auth = surfaces.authorize(sender, 'list');
        if (!auth.allowed) return [];
        return surfaces.list();
      }),

      'surface-state': handle((event, surfaceId?: string): NativeSurfaceSnapshot | null => {
        const surfaces = requireSurfaces(controller);
        const sender = senderWindow(event);
        if (!surfaces || !sender) return null;
        const auth = surfaces.authorize(sender, 'state', surfaceId);
        if (!auth.allowed) return null;
        if (surfaceId) return surfaces.getState(surfaceId);
        const ctx = surfaces.getContextForSender(sender);
        if (ctx.role === 'satellite') return surfaces.getState(ctx.surfaceId);
        return null;
      }),

      'surface-context': handle((event): NativeSurfaceContext => {
        const surfaces = requireSurfaces(controller);
        const sender = senderWindow(event);
        if (!surfaces || !sender) return { role: 'unknown' };
        return surfaces.getContextForSender(sender);
      }),
      'open-support-link': listen((_event, destination: 'documentation' | 'issues') => {
        const url = resolveSupportLinkUrl(destination);
        if (!url) return;
        void shell.openExternal(url);
      }),
    },
    { eventPrefix: true },
  );
}
