/**
 * What Shader Doctor is sent, and what its reports are tied to: host helpers
 * that read the open draft, the record's texture slots and — only from what the
 * preview already did — whether each slot's image loaded.
 *
 * Nothing here loads a texture. A slot is `empty` when the record has no image
 * in it and `loaded` only when the preview holds a decoded image for it; a
 * load under way or settled as a failure is reported as such, and everything
 * the preview has not observed is `unknown` — which the Doctor reports as not
 * checked, never as fine.
 */
import { hasActivePostProcessing, type TextureChannels } from '@shadergrove/shared/model';
import {
  sourceFingerprint,
  type AnalyzerRequest,
  type ResourceState,
} from '@shadergrove/shared/plugin';
import type { ShaderProject } from '@shadergrove/shared/project';
import type { ShaderEngine } from '../../rendering/shader-engine';
import type { ShaderStore } from '../../workspace/shader-store';
import type { ToolSource } from '../plugin-tools';

/** The decode bookkeeping the engine keeps for its four image slots (`TextureManager`). */
const decoded = (texture: unknown): boolean => {
  const image = (texture as { image?: { width?: unknown } } | null)?.image;
  return typeof image?.width === 'number' && image.width > 0;
};

/**
 * Each slot's load state as the preview has observed it. `engine` is the live
 * preview renderer, if any; `project` is the draft whose bindings tell which
 * of its passes would show the slot's texture.
 */
export function doctorSlotStates(
  channels: TextureChannels,
  project: ShaderProject | null,
  engine: ShaderEngine | null,
): ResourceState[] {
  return channels.map((channel, slot): ResourceState => {
    if (channel.ext === null) return 'empty';
    if (!engine) return 'unknown';
    // `empty` here: the preview has not taken the slot's assignment up yet.
    const state = engine.textureSlotState(slot);
    if (state === 'loading' || state === 'failed') return state;
    if (state !== 'ready') return 'unknown';
    // `ready` also covers a slot no pass has resolved yet: only a decoded image
    // behind one of its bindings is a load the preview has actually seen.
    const seen = (project?.passes ?? []).some((pass) =>
      pass.channels.some((binding, index) => {
        if (binding.kind !== 'texture' || binding.slot !== slot) return false;
        const texture = engine.passChannelTexture(pass.id, index);
        return !engine.isPlaceholderTexture(texture) && decoded(texture);
      }),
    );
    return seen ? 'loaded' : 'unknown';
  });
}

/**
 * The analyzer snapshot of the open draft — unsaved edits, controls, values,
 * render settings and texture metadata with `states` — or `null` when no
 * shader is open. Built synchronously from the store, as `ToolSession.analyze`
 * requires.
 */
export function doctorSnapshot(
  store: ShaderStore,
  states: readonly ResourceState[],
): Omit<AnalyzerRequest, 'profileId' | 'revision'> | null {
  const record = store.record();
  const draft = store.draft();
  if (!record || !draft) return null;
  return {
    name: record.name,
    project: draft.project,
    controls: store.controls(),
    params: store.params(),
    render: draft.render,
    channels: store.channels().map((channel, slot) => ({
      ...channel,
      present: channel.ext !== null,
      state: states[slot] ?? 'unknown',
    })),
    postProcessingActive: hasActivePostProcessing(draft.render),
  };
}

/**
 * What a Doctor report is tied to: the draft (`PluginTools.draftSource`) plus
 * the record's texture slots and their observed states — so assigning,
 * clearing or re-loading a texture makes a report out of date, which the
 * draft's own fingerprint does not.
 */
export function doctorSource(
  draftSource: () => ToolSource | null,
  channels: () => TextureChannels,
  states: () => readonly ResourceState[],
): () => ToolSource | null {
  return () => {
    const draft = draftSource();
    if (!draft) return null;
    return {
      shaderId: draft.shaderId,
      fingerprint: sourceFingerprint([draft.fingerprint, channels(), states()]),
    };
  };
}
