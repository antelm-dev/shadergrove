import { app, BrowserWindow, Menu, net, safeStorage, screen, shell } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { createIpcContainer } from 'electron-ipc-module';

import { resolveI18nDir } from '@shadergrove/backend/i18n';
import { LOCAL_SCOPE, ShaderLibrary } from '@shadergrove/backend/library';
import { createLegacyReader, legacyLibraryExists } from '@shadergrove/backend/persistence/legacy';
import { SqliteRepository } from '@shadergrove/backend/persistence/sqlite';
import { WELL_KNOWN_SURFACE_IDS } from '@shadergrove/shared/surfaces';
import { DesktopAccountSession, findCallbackUrl } from './account/account-session';
import { configureAppIdentity } from './core/app-identity';
import { prepare } from './core/bootstrap';
import { createCustomScheme } from './core/electron';
import { UpdateController } from './core/updater';
import { env } from './env';
import { createAccountIpc } from './ipc/account.ipc';
import { createFilesIpc } from './ipc/files.ipc';
import { createI18nIpc } from './ipc/i18n.ipc';
import { createMigrationIpc } from './ipc/migration.ipc';
import { createPluginsIpc } from './ipc/plugins.ipc';
import { createShaderIpc } from './ipc/shader.ipc';
import { broadcastSync, createSyncIpc } from './ipc/sync.ipc';
import { createUpdateIpc } from './ipc/update.ipc';
import { createWindowIpc, type CloseController } from './ipc/window.ipc';
import { notifyingWrites, SyncService } from './sync/sync-service';
import {
  applyNavigationPolicy,
  createAppUrlChecker,
  createSecureBrowserWindow,
  SurfaceWindowManager,
  SurfaceWindowRegistry,
  SurfaceWindowStateStore,
} from './windows';

configureAppIdentity(app, env.production);

const scheme = createCustomScheme(env.scheme, {
  standard: true,
  secure: true,
  supportFetchAPI: true,
});
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};
const CLIENT_DIR = resolve(env.paths.clientDir);

async function serveClient(request: Request): Promise<Response> {
  let requested: string;
  try {
    requested = decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, ''));
  } catch {
    return new Response('Bad request', { status: 400 });
  }
  requested ||= 'index.html';
  let file = resolve(CLIENT_DIR, requested);
  const rel = relative(CLIENT_DIR, file);
  if (rel.startsWith('..') || isAbsolute(rel)) return new Response('Forbidden', { status: 403 });
  try {
    const data = await readFile(file);
    return new Response(data, {
      headers: { 'content-type': MIME_TYPES[extname(file)] ?? 'application/octet-stream' },
    });
  } catch {
    if (extname(requested)) return new Response('Not found', { status: 404 });
    file = join(CLIENT_DIR, 'index.html');
    return new Response(await readFile(file), { headers: { 'content-type': 'text/html' } });
  }
}

interface WindowState {
  bounds?: Electron.Rectangle;
  maximized?: boolean;
}

function validBounds(value: unknown): Electron.Rectangle | undefined {
  const item = value as Partial<Electron.Rectangle> | null;
  if (
    !item ||
    !['x', 'y', 'width', 'height'].every((key) =>
      Number.isFinite(item[key as keyof Electron.Rectangle]),
    )
  )
    return undefined;
  if ((item.width ?? 0) < 800 || (item.height ?? 0) < 600) return undefined;
  const bounds = item as Electron.Rectangle;
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return (
      bounds.x < area.x + area.width &&
      bounds.x + bounds.width > area.x &&
      bounds.y < area.y + area.height &&
      bounds.y + bounds.height > area.y
    );
  })
    ? bounds
    : undefined;
}

async function readWindowState(path: string): Promise<WindowState> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as WindowState;
  } catch {
    return {};
  }
}

/**
 * On the first launch after the SQLite switch, import the old file library at
 * `<userData>/library/shaders` into the database — once, transactionally, and
 * verified — then leave the files untouched. Records a marker in
 * `storage_metadata` so it never runs again (and a fresh install never sees a
 * migration at all).
 */
async function migrateLegacyLibrary(library: ShaderLibrary, libraryDir: string): Promise<void> {
  if (await library.getMeta('legacy_migration')) return;
  if (!(await legacyLibraryExists(libraryDir))) {
    await library.setMeta('legacy_migration', 'none');
    return;
  }
  try {
    const summary = await library.migrateLegacy(createLegacyReader(libraryDir));
    await library.setMeta(
      'legacy_migration',
      JSON.stringify({ at: new Date().toISOString(), ...summary }),
    );
    console.log(`[migration] imported ${summary.imported} shader(s) from the legacy file library`);
  } catch (error) {
    // Roll-forward next launch: leave the marker unset, keep the files intact.
    console.error(
      '[migration] importing the legacy file library failed; the original files were left ' +
        'untouched and the import will be retried on the next launch.',
      error,
    );
  }
}

const closeController: CloseController = {
  approved: new WeakSet(),
  openOutput: () => undefined,
  closeOutput: () => undefined,
  outputOpen: () => false,
};
let mainWindow: BrowserWindow | null = null;
let surfaceManager: SurfaceWindowManager | null = null;

const account = new DesktopAccountSession({
  accountUrl: env.accountUrl,
  dataDir: app.getPath('userData'),
  fetch: (url, init) => net.fetch(url, init),
  safeStorage,
  openExternal: (url) => shell.openExternal(url),
});
/** Only `shader-studio://auth/callback` reaches the account; other links are ignored. */
const openCallback = (argv: readonly string[]) => {
  const url = findCallbackUrl(argv);
  if (url) void app.whenReady().then(() => account.handleCallback(url));
};
if (account.state().status !== 'disabled') {
  // A dev build is `electron <entry>`, so the link must relaunch both.
  const entry = process.defaultApp
    ? process.argv.slice(1).find((arg) => !arg.startsWith('-') && !findCallbackUrl([arg]))
    : undefined;
  if (entry) app.setAsDefaultProtocolClient(env.scheme, process.execPath, [resolve(entry)]);
  else app.setAsDefaultProtocolClient(env.scheme);
  app.on('open-url', (event, url) => {
    event.preventDefault();
    openCallback([url]);
  });
}

const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
else
  app.on('second-instance', (_event, argv) => {
    mainWindow?.restore();
    mainWindow?.focus();
    openCallback(argv);
  });

prepare({
  protocols: env.production ? [{ scheme, handler: serveClient }] : [],
  onReady: async () => {
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
    const userData = app.getPath('userData');
    const statePath = join(userData, 'window-state.json');
    const surfaceStatePath = join(userData, 'surface-window-state.json');
    const migrationPath = join(userData, 'migration.json');
    const saved = await readWindowState(statePath);
    const bounds = validBounds(saved.bounds);
    const i18nDir = env.production ? join(process.resourcesPath, 'i18n') : await resolveI18nDir();

    // SQLite lives in the main process only; the web app reaches it via IPC.
    const libraryDir = join(userData, 'library');
    await mkdir(libraryDir, { recursive: true });
    // The desktop app is offline and single-user: everything it stores belongs
    // to the local user, and no network identity is ever involved.
    const library = new ShaderLibrary(
      new SqliteRepository({ location: join(libraryDir, 'shader-studio.sqlite') }),
      LOCAL_SCOPE,
    );
    await library.init();
    void account.restore();
    // A second instance only forwards its link, through `second-instance`.
    if (primaryInstance) openCallback(process.argv);
    await migrateLegacyLibrary(library, libraryDir);

    const isAppUrl = createAppUrlChecker({
      production: env.production,
      scheme: env.scheme,
      devServerUrl: env.devServerUrl,
    });
    const resolveSurfaceUrl = (path: string) => {
      const base = env.production ? env.urls.web : env.devServerUrl;
      return new URL(path, base).toString();
    };

    const registry = new SurfaceWindowRegistry();
    const stateStore = new SurfaceWindowStateStore(surfaceStatePath);
    await stateStore.load();

    surfaceManager = new SurfaceWindowManager({
      registry,
      stateStore,
      preload: env.paths.preload,
      resolveUrl: resolveSurfaceUrl,
      navigationFor: (role) => ({
        isAppUrl,
        openExternalHttp: role === 'main',
      }),
      getMainWindow: () => mainWindow,
      onSatelliteChanged: (event) => {
        const win = mainWindow;
        if (!win || win.isDestroyed()) return;
        if ('open' in event && event.open === false) {
          win.webContents.send('surface-changed', event);
          if (event.surfaceId === WELL_KNOWN_SURFACE_IDS.livePreviewOutput) {
            win.webContents.send('output-state-changed', false);
          }
          return;
        }
        const openEvent = { ...event, open: true as const };
        win.webContents.send('surface-changed', openEvent);
        if (event.surfaceId === WELL_KNOWN_SURFACE_IDS.livePreviewOutput) {
          win.webContents.send('output-state-changed', true);
        }
      },
      onReturnedToWorkspace: (surfaceId, kind) => {
        mainWindow?.webContents.send('surface-returned', { surfaceId, kind });
      },
    });

    closeController.surfaces = surfaceManager;
    closeController.getMainWindow = () => mainWindow;
    closeController.openOutput = () => {
      void surfaceManager?.openLivePreviewOutput();
    };
    closeController.closeOutput = () => {
      surfaceManager?.closeLivePreviewOutput();
    };
    closeController.outputOpen = () => surfaceManager?.isLivePreviewOutputOpen() ?? false;

    const sync = new SyncService(library, account, broadcastSync);

    const ipc = createIpcContainer();
    const updates = new UpdateController(() => {
      for (const window of BrowserWindow.getAllWindows()) closeController.approved.add(window);
    });
    await ipc.loadAll({
      shader: createShaderIpc(notifyingWrites(library, () => sync.changed())),
      files: createFilesIpc(),
      i18n: createI18nIpc(i18nDir),
      migration: createMigrationIpc(library, migrationPath),
      window: createWindowIpc(closeController),
      update: createUpdateIpc(updates),
      account: createAccountIpc(account),
      sync: createSyncIpc(sync),
      // Only the main window manages plugins; output and satellite windows read the data-only ones.
      plugins: createPluginsIpc(
        join(userData, 'plugins'),
        join(userData, 'plugin-bootstrap.json'),
        (sender) => sender === mainWindow?.webContents,
      ),
    });
    void sync.run();

    const win = createSecureBrowserWindow({
      width: bounds?.width ?? 1440,
      height: bounds?.height ?? 900,
      x: bounds?.x,
      y: bounds?.y,
      minWidth: 800,
      minHeight: 600,
      show: false,
      frame: false,
      backgroundColor: '#090b10',
      webPreferences: { preload: env.paths.preload },
    });
    mainWindow = win;

    if (saved.maximized) win.maximize();
    win.once('ready-to-show', () => win.show());
    win.on('close', (event) => {
      if (closeController.approved.has(win)) return;
      event.preventDefault();
      win.webContents.send('close-requested');
    });
    win.on('closed', () => {
      surfaceManager?.closeAllSatellites();
      mainWindow = null;
    });
    const pushWindowState = () => {
      win.webContents.send('state-changed', {
        maximized: win.isMaximized(),
        fullscreen: win.isFullScreen(),
      });
    };
    const saveState = () =>
      void writeFile(
        statePath,
        JSON.stringify({ bounds: win.getNormalBounds(), maximized: win.isMaximized() }),
        'utf8',
      );
    win.on('resize', saveState);
    win.on('move', saveState);
    win.on('maximize', () => {
      saveState();
      pushWindowState();
    });
    win.on('unmaximize', () => {
      saveState();
      pushWindowState();
    });
    // Picks up the account's changes when the user comes back to the app.
    win.on('focus', () => sync.focused());
    win.on('enter-full-screen', pushWindowState);
    win.on('leave-full-screen', pushWindowState);

    applyNavigationPolicy(win, { isAppUrl, openExternalHttp: true });

    if (env.production) await win.loadURL(env.urls.web);
    else {
      const load = () => void win.loadURL(env.devServerUrl);
      win.webContents.on('did-fail-load', () => setTimeout(load, 300));
      load();
    }
    void updates.check();
  },
});

app.on('before-quit', () => {
  surfaceManager?.beginQuit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
