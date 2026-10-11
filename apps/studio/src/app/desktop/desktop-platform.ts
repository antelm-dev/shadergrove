import { Injectable, computed, signal } from '@angular/core';

import type { Bundle, ImportMode } from '@shadergrove/shared/model';
import type {
  NativeSurfaceChangedEvent,
  NativeSurfaceOpenRequest,
  NativeSurfaceResult,
} from '../../desktop/contracts/contracts';

/** Semantic Help destinations — never pass raw URLs to the main process. */
export type SupportLinkDestination = 'documentation' | 'issues';

type WindowState = { maximized: boolean; fullscreen: boolean };

const IDLE_STATE: WindowState = { maximized: false, fullscreen: false };

@Injectable({ providedIn: 'root' })
export class DesktopPlatform {
  readonly available = typeof window !== 'undefined' && 'electron' in window;

  private readonly windowStateSignal = signal(IDLE_STATE);

  readonly maximized = computed(() => this.windowStateSignal().maximized);
  readonly fullscreen = computed(() => this.windowStateSignal().fullscreen);
  readonly outputOpen = signal(false);

  constructor() {
    if (!this.available) return;
    void this.subscribeWindowState();
  }

  private async subscribeWindowState(): Promise<void> {
    const state = await window.electron.bridge.window.state();
    this.windowStateSignal.set(state);
    window.electron.bridge.window.onStateChanged((state) => this.windowStateSignal.set(state));
    const open = await window.electron.bridge.window.outputOpen();
    this.outputOpen.set(open);
    window.electron.bridge.window.onOutputStateChanged((open) => this.outputOpen.set(open));
  }

  async openBundle(): Promise<{ name: string; bundle: unknown } | null> {
    if (!this.available) return null;
    const result = await window.electron.bridge.files.openBundle();
    if (result.status === 'cancelled') return null;
    if (result.status === 'error') throw new Error(result.message);
    return result.value;
  }

  async saveBundle(filename: string, bundle: Bundle): Promise<boolean> {
    if (!this.available) return false;
    const result = await window.electron.bridge.files.saveBundle(filename, bundle);
    if (result.status === 'error') throw new Error(result.message);
    return result.status === 'ok';
  }

  async savePng(filename: string, bytes: Uint8Array): Promise<boolean> {
    if (!this.available) return false;
    const result = await window.electron.bridge.files.savePng(filename, bytes);
    if (result.status === 'error') throw new Error(result.message);
    return result.status === 'ok';
  }

  /** Saves what a plugin exporter produced, with the extension its manifest declared. */
  async saveExport(filename: string, bytes: Uint8Array, extension: string): Promise<boolean> {
    if (!this.available) return false;
    const result = await window.electron.bridge.files.saveExport(filename, bytes, extension);
    if (result.status === 'error') throw new Error(result.message);
    return result.status === 'ok';
  }

  /**
   * Opens a save dialog for a WebM export. `null` if the user declined.
   *
   * The path is held in a main-process session until `commitVideo` writes the
   * bytes or `abortVideo` throws the session away — nothing touches the disk
   * until the encode has finished.
   */
  async beginVideo(stem: string): Promise<{ id: string; path: string } | null> {
    if (!this.available) return null;
    const result = await window.electron.bridge.files.beginVideo(stem);
    if (result.status === 'error') throw new Error(result.message);
    return result.status === 'ok' ? result.value : null;
  }

  async commitVideo(id: string, bytes: Uint8Array): Promise<string> {
    if (!this.available) throw new Error('Desktop video export is not available');
    const result = await window.electron.bridge.files.commitVideo(id, bytes);
    if (result.status === 'error') throw new Error(result.message);
    if (result.status !== 'ok') throw new Error('The video export was cancelled');
    return result.value.path;
  }

  async abortVideo(id: string): Promise<void> {
    if (!this.available) return;
    const result = await window.electron.bridge.files.abortVideo(id);
    if (result.status === 'error') throw new Error(result.message);
  }

  /**
   * Opens a folder to write an image sequence into. `null` if the user declined.
   *
   * A sequence is thousands of files, so it is a *session*: the folder is chosen
   * once, and from then on the renderer only ever says which frame number it is
   * handing over. It never names a file and never learns a path.
   */
  async beginSequence(
    stem: string,
    padding: number,
  ): Promise<{ id: string; directory: string } | null> {
    if (!this.available) return null;
    const result = await window.electron.bridge.files.beginSequence(stem, padding);
    if (result.status === 'error') throw new Error(result.message);
    return result.status === 'ok' ? result.value : null;
  }

  async writeFrame(id: string, index: number, bytes: Uint8Array): Promise<void> {
    if (!this.available) return;
    const result = await window.electron.bridge.files.writeFrame(id, index, bytes);
    if (result.status === 'error') throw new Error(result.message);
  }

  /** Closes a sequence. Cancelling it removes every frame already written. */
  async endSequence(
    id: string,
    cancelled: boolean,
  ): Promise<{ directory: string; frames: number } | null> {
    if (!this.available) return null;
    const result = await window.electron.bridge.files.endSequence(id, cancelled);
    if (result.status === 'error') throw new Error(result.message);
    return result.status === 'ok' ? result.value : null;
  }

  /** Raw bytes for a channel's image, or `null` if the shader has nothing assigned to it. */
  async readTexture(
    shaderId: string,
    channel: number,
  ): Promise<{ bytes: Uint8Array; ext: string } | null> {
    if (!this.available) return null;
    return window.electron.bridge.shader.readTexture(shaderId, channel);
  }

  /** Raw bytes for a shader's preview, or `null` if it has never been saved with one. */
  async readThumbnail(shaderId: string): Promise<{ bytes: Uint8Array; ext: string } | null> {
    if (!this.available) return null;
    return window.electron.bridge.shader.readThumbnail(shaderId);
  }

  migrationPending(): Promise<boolean> {
    return this.available ? window.electron.bridge.migration.pending() : Promise.resolve(false);
  }

  async migrate(): Promise<string | null> {
    const result = await window.electron.bridge.migration.select();
    if (result.status === 'cancelled') return null;
    if (result.status === 'error') throw new Error(result.message);
    return `Imported ${result.imported} shader${result.imported === 1 ? '' : 's'}${result.skipped ? `; skipped ${result.skipped}` : ''}`;
  }

  declineMigration(): Promise<void> {
    return window.electron.bridge.migration.decline();
  }

  onCloseRequested(listener: () => void): () => void {
    return this.available
      ? window.electron.bridge.window.onCloseRequested(listener)
      : () => undefined;
  }

  approveClose(approved: boolean): void {
    if (this.available) window.electron.bridge.window.approveClose(approved);
  }

  minimize(): void {
    if (this.available) window.electron.bridge.window.minimize();
  }

  toggleMaximize(): void {
    if (this.available) window.electron.bridge.window.toggleMaximize();
  }

  toggleFullscreen(): void {
    if (this.available) window.electron.bridge.window.toggleFullscreen();
  }

  /** Toggles DevTools for the Electron window that owns this renderer. */
  toggleDevTools(): void {
    if (this.available) window.electron.bridge.window.toggleDevtools();
  }

  /** Opens an allowlisted Help destination in the system browser. */
  openSupportLink(destination: SupportLinkDestination): void {
    if (this.available) window.electron.bridge.window.openSupportLink(destination);
  }

  openOutput(): void {
    if (this.available) window.electron.bridge.window.openOutput();
  }

  closeOutput(): void {
    if (this.available) window.electron.bridge.window.closeOutput();
  }

  /** Opens a native satellite, or focuses the one already open for that id. */
  openSurface(request: NativeSurfaceOpenRequest): Promise<NativeSurfaceResult> {
    if (!this.available) return Promise.resolve({ status: 'rejected', reason: 'unavailable' });
    return window.electron.bridge.window.surfaceOpen(request);
  }

  /** Closes a native satellite's window; the main process reports it through `surface-changed`. */
  closeSurface(surfaceId: string): Promise<NativeSurfaceResult> {
    if (!this.available) return Promise.resolve({ status: 'rejected', reason: 'unavailable' });
    return window.electron.bridge.window.surfaceClose(surfaceId);
  }

  /** Asks the main window to dock a satellite back; the main process then closes its window. */
  returnSurface(surfaceId: string): Promise<NativeSurfaceResult> {
    if (!this.available) return Promise.resolve({ status: 'rejected', reason: 'unavailable' });
    return window.electron.bridge.window.surfaceReturn(surfaceId);
  }

  onSurfaceChanged(listener: (event: NativeSurfaceChangedEvent) => void): () => void {
    return this.available
      ? window.electron.bridge.window.onSurfaceChanged(listener)
      : () => undefined;
  }

  /** A satellite asked to be docked back into this window (`surfaceReturn`). */
  onSurfaceReturned(listener: (payload: { surfaceId: string }) => void): () => void {
    return this.available
      ? window.electron.bridge.window.onSurfaceReturned(listener)
      : () => undefined;
  }

  close(): void {
    if (this.available) window.electron.bridge.window.close();
  }

  /** Keeps the import mode in the platform-neutral UI layer. */
  mode(value: ImportMode): ImportMode {
    return value;
  }
}
