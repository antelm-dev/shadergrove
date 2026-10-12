import { app } from 'electron';
import { autoUpdater } from 'electron-updater';

import type { UpdateState } from '../../contracts/contracts';
import { updateEmitter } from '../ipc/update.ipc';
import { updateChannelForVersion } from './update-channel';

const unsupportedState = (): UpdateState => ({
  status: 'unavailable',
  currentVersion: app.getVersion(),
  message: app.isPackaged
    ? 'Les mises à jour automatiques ne sont disponibles que pour la version installée.'
    : 'Les mises à jour automatiques ne sont pas disponibles en mode développement.',
});

/** Owns electron-updater and exposes a small, serialisable state machine to IPC. */
export class UpdateController {
  private state: UpdateState;
  private readonly supported =
    app.isPackaged && process.platform === 'win32' && !process.env['PORTABLE_EXECUTABLE_FILE'];

  constructor(private readonly beforeInstall: () => void) {
    this.state = this.supported
      ? { status: 'idle', currentVersion: app.getVersion() }
      : unsupportedState();

    if (!this.supported) return;

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.channel = updateChannelForVersion(app.getVersion());
    autoUpdater.allowPrerelease = autoUpdater.channel !== 'latest';

    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking' }));
    autoUpdater.on('update-available', (info) =>
      this.set({ status: 'available', availableVersion: info.version }),
    );
    autoUpdater.on('update-not-available', () => this.set({ status: 'up-to-date' }));
    autoUpdater.on('download-progress', (progress) =>
      this.set({
        status: 'downloading',
        availableVersion: this.state.availableVersion,
        progress: Math.max(0, Math.min(100, progress.percent)),
      }),
    );
    autoUpdater.on('update-downloaded', (info) =>
      this.set({ status: 'downloaded', availableVersion: info.version, progress: 100 }),
    );
    autoUpdater.on('error', (error) =>
      this.set({
        status: 'error',
        availableVersion: this.state.availableVersion,
        message: error.message,
      }),
    );
  }

  current(): UpdateState {
    return this.state;
  }

  async check(): Promise<UpdateState> {
    if (!this.supported || ['checking', 'downloading'].includes(this.state.status))
      return this.state;
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      this.set({ status: 'error', message: messageOf(error) });
    }
    return this.state;
  }

  async update(): Promise<UpdateState> {
    if (!this.supported) return this.state;

    if (this.state.status === 'available') {
      try {
        await autoUpdater.downloadUpdate();
      } catch (error) {
        this.set({
          status: 'error',
          availableVersion: this.state.availableVersion,
          message: messageOf(error),
        });
      }
    } else if (this.state.status === 'downloaded') {
      this.beforeInstall();
      autoUpdater.quitAndInstall(false, true);
    } else if (['idle', 'up-to-date', 'error'].includes(this.state.status)) {
      return this.check();
    }

    return this.state;
  }

  private set(patch: Omit<UpdateState, 'currentVersion'>): void {
    this.state = { currentVersion: app.getVersion(), ...patch };
    updateEmitter.emit('update-state-changed', this.state);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
