import { Injectable, Injector, computed, inject, type Signal } from '@angular/core';

import { CONFIG_DOC, type CompileDiagnostic } from '@shadergrove/shared/diagnostic';
import type {
  ParamValue,
  Preset,
  RenderSettings,
  ShaderControl,
  ShaderParams,
  TextureChannelSettingsPatch,
  TextureChannels,
} from '@shadergrove/shared/model';
import type { InspectorTab } from '@shadergrove/shared/panel-prefs';
import type { ChannelIndex } from '@shadergrove/shared/project';
import { EditorNavigation } from '../../editor/editor-navigation';
import { Preferences } from '../../prefs/preferences';
import { RendererHandle } from '../../rendering/renderer-handle';
import { SurfaceLayoutService } from '../../surfaces/surface-layout';
import { ShaderStore } from '../../workspace/shader-store';
import { WorkspaceActions } from '../workspace-actions';

/** The open shader, as much of it as the inspector needs to know which one it is. */
export interface InspectedShader {
  readonly id: string;
  /** Its version: texture thumbnails are cached per version. */
  readonly updatedAt: string;
}

/** The System folder's settings: how the preview runs, not what the shader is. */
export interface SystemSettings {
  readonly resolutionScale: number;
  readonly paused: boolean;
  readonly autoRipples: boolean;
}

/**
 * What the inspector's panels read and change, and nothing else.
 *
 * In the main window it is the editing session itself
 * (`WorkspaceInspectorSession`). In the inspector's own native window it is a
 * mirror of it that asks the main window to make every change, so that
 * window never holds a second session. The panels cannot tell the two apart.
 */
@Injectable({ providedIn: 'root', useFactory: () => inject(WorkspaceInspectorSession) })
export abstract class InspectorSession {
  abstract readonly shader: Signal<InspectedShader | null>;
  abstract readonly controls: Signal<readonly ShaderControl[]>;
  abstract readonly params: Signal<ShaderParams>;
  abstract readonly channels: Signal<TextureChannels>;
  abstract readonly render: Signal<RenderSettings | null>;
  abstract readonly diagnostics: Signal<readonly CompileDiagnostic[]>;
  abstract readonly presets: Signal<readonly Preset[]>;
  abstract readonly activePresetId: Signal<string | null>;
  abstract readonly fps: Signal<number>;
  abstract readonly system: Signal<SystemSettings>;
  /** The open tab. */
  abstract readonly tab: Signal<InspectorTab>;

  abstract selectTab(tab: InspectorTab): void;
  /** Collapse: hide the inspector, wherever it is. */
  abstract hide(): void;
  abstract setParam(key: string, value: ParamValue): void;
  abstract resetParams(): void;
  abstract setTextureImage(channel: ChannelIndex, file: File): Promise<void>;
  abstract clearTextureImage(channel: ChannelIndex): Promise<void>;
  abstract setChannelSettings(
    channel: ChannelIndex,
    patch: TextureChannelSettingsPatch,
  ): Promise<void>;
  abstract setRender(render: RenderSettings): void;
  abstract applyPreset(presetId: string): void;
  /** Asks for a name, then saves the current values as a preset. */
  abstract savePreset(): Promise<void>;
  /** Asks for confirmation, then deletes the preset. */
  abstract deletePreset(presetId: string, name: string): Promise<void>;
  abstract setSystem(patch: Partial<SystemSettings>): void;
  /** Saves the preview's current frame as an image. */
  abstract captureImage(): Promise<void>;
  /** Opens the editor on the Config, where the controls are declared. */
  abstract editControls(): void;
}

/**
 * The main window's inspector session: the editing session itself. Everything
 * beyond the store is reached only when used, so a panel that never touches
 * the System folder or the presets never constructs what they need.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceInspectorSession extends InspectorSession {
  private readonly store = inject(ShaderStore);
  private readonly injector = inject(Injector);

  readonly shader = computed<InspectedShader | null>(
    () => {
      const record = this.store.record();
      return record ? { id: record.id, updatedAt: record.updatedAt } : null;
    },
    { equal: (a, b) => a?.id === b?.id && a?.updatedAt === b?.updatedAt },
  );
  readonly controls = computed(() => this.store.controls());
  readonly params = computed(() => this.store.params());
  readonly channels = computed(() => this.store.channels());
  readonly render = computed(() => this.store.draft()?.render ?? null);
  readonly diagnostics = computed(() => this.store.allDiagnostics());
  readonly presets = computed(() => this.store.presets());
  readonly activePresetId = computed(() => this.store.activePresetId());
  readonly fps = computed(() => this.renderer.fps());
  readonly system = computed<SystemSettings>(
    () => {
      const { resolutionScale, paused, autoRipples } = this.preferences.value();
      return { resolutionScale, paused, autoRipples };
    },
    {
      equal: (a, b) =>
        a.resolutionScale === b.resolutionScale &&
        a.paused === b.paused &&
        a.autoRipples === b.autoRipples,
    },
  );
  readonly tab = computed(() => this.layout.inspectorTab());

  private get preferences(): Preferences {
    return this.injector.get(Preferences);
  }

  private get renderer(): RendererHandle {
    return this.injector.get(RendererHandle);
  }

  private get layout(): SurfaceLayoutService {
    return this.injector.get(SurfaceLayoutService);
  }

  selectTab(tab: InspectorTab): void {
    this.layout.setInspectorTab(tab);
  }

  hide(): void {
    this.layout.close(this.layout.inspectorId);
  }

  setParam(key: string, value: ParamValue): void {
    this.store.setParam(key, value);
  }

  resetParams(): void {
    this.store.resetParams();
  }

  setTextureImage(channel: ChannelIndex, file: File): Promise<void> {
    return this.store.setTextureImage(channel, file);
  }

  clearTextureImage(channel: ChannelIndex): Promise<void> {
    return this.store.clearTextureImage(channel);
  }

  setChannelSettings(channel: ChannelIndex, patch: TextureChannelSettingsPatch): Promise<void> {
    return this.store.setChannelSettings(channel, patch);
  }

  setRender(render: RenderSettings): void {
    this.store.setRender(render);
  }

  applyPreset(presetId: string): void {
    this.store.applyPreset(presetId);
  }

  savePreset(): Promise<void> {
    return this.injector.get(WorkspaceActions).savePreset();
  }

  deletePreset(presetId: string, name: string): Promise<void> {
    return this.injector.get(WorkspaceActions).deletePreset(presetId, name);
  }

  setSystem(patch: Partial<SystemSettings>): void {
    this.preferences.patch(patch);
  }

  async captureImage(): Promise<void> {
    const name = this.store.record()?.id ?? 'shader';
    if (!(await this.renderer.screenshot(name))) {
      this.store.notice.set({ text: 'Nothing to capture yet', error: true });
    }
  }

  /**
   * Restoring a closed or minimized editor is the layout's job; picking the
   * document and its view is the editor panel's, which hears it through the
   * navigation request.
   */
  editControls(): void {
    this.layout.openEditor();
    this.injector.get(EditorNavigation).reveal(CONFIG_DOC, 0);
  }
}
