import { Injectable, inject } from '@angular/core';

import type {
  ParamValue,
  RenderSettings,
  TextureChannelSettingsPatch,
} from '@shadergrove/shared/model';
import type { InspectorTab } from '@shadergrove/shared/panel-prefs';
import type { ChannelIndex } from '@shadergrove/shared/project';
import { WELL_KNOWN_SURFACE_IDS } from '@shadergrove/shared/surfaces';
import { DesktopPlatform } from '../../desktop/desktop-platform';
import { SessionMirror } from '../../workspace/session-sync/session-mirror';
import { PresetDialogs } from '../dialogs/preset-dialogs';
import { InspectorSession, type SystemSettings } from './inspector-session';

/**
 * The inspector's session in its own native window: the main window's,
 * mirrored, with every change sent there to be validated and made. Values
 * the user is dragging or typing (parameters, post-processing, the System
 * folder, the tab) show here at once, ahead of the main window's answer.
 * Questions — a preset's name, deleting one — are asked here, where the user
 * is; only the answer travels.
 */
@Injectable()
export class RemoteInspectorSession extends InspectorSession {
  private readonly mirror = inject(SessionMirror);
  private readonly dialogs = inject(PresetDialogs);
  private readonly desktop = inject(DesktopPlatform);

  readonly shader = this.mirror.field('shader');
  readonly controls = this.mirror.field('controls');
  readonly params = this.mirror.field('params');
  readonly channels = this.mirror.field('channels');
  readonly render = this.mirror.field('render');
  readonly diagnostics = this.mirror.field('diagnostics');
  readonly presets = this.mirror.field('presets');
  readonly activePresetId = this.mirror.field('activePresetId');
  readonly fps = this.mirror.field('fps');
  readonly system = this.mirror.field('system');
  readonly tab = this.mirror.field('inspectorTab');

  selectTab(tab: InspectorTab): void {
    void this.mirror.send({ kind: 'inspector-tab', tab }, { inspectorTab: tab });
  }

  /** Collapse closes this window; the inspector stays detached, hidden. */
  hide(): void {
    void this.desktop.closeSurface(WELL_KNOWN_SURFACE_IDS.inspector).catch(() => undefined);
  }

  setParam(key: string, value: ParamValue): void {
    void this.mirror.send(
      { kind: 'set-param', key, value },
      { params: { ...this.params(), [key]: value } },
    );
  }

  resetParams(): void {
    void this.mirror.send({ kind: 'reset-params' });
  }

  async setTextureImage(channel: ChannelIndex, file: File): Promise<void> {
    await this.mirror.send({ kind: 'set-texture', channel, file });
  }

  async clearTextureImage(channel: ChannelIndex): Promise<void> {
    await this.mirror.send({ kind: 'clear-texture', channel });
  }

  async setChannelSettings(
    channel: ChannelIndex,
    patch: TextureChannelSettingsPatch,
  ): Promise<void> {
    await this.mirror.send({ kind: 'set-channel-settings', channel, patch });
  }

  setRender(render: RenderSettings): void {
    void this.mirror.send({ kind: 'set-render', render }, { render });
  }

  applyPreset(presetId: string): void {
    void this.mirror.send({ kind: 'apply-preset', presetId });
  }

  async savePreset(): Promise<void> {
    const answer = await this.dialogs.askToSave();
    if (answer) await this.mirror.send({ kind: 'save-preset', ...answer });
  }

  async deletePreset(presetId: string, name: string): Promise<void> {
    if (await this.dialogs.confirmDelete(name)) {
      await this.mirror.send({ kind: 'delete-preset', presetId });
    }
  }

  setSystem(patch: Partial<SystemSettings>): void {
    void this.mirror.send(
      { kind: 'set-system', patch },
      { system: { ...this.system(), ...patch } },
    );
  }

  async captureImage(): Promise<void> {
    await this.mirror.send({ kind: 'capture-image' });
  }

  editControls(): void {
    void this.mirror.send({ kind: 'edit-controls' });
  }
}
