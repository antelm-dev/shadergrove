/**
 * Protocol 4: tool contributions.
 *
 * Protocols 1–3 move effects and projects in and out, and dress the app. Protocol
 * 4 adds three kinds that *work on* what the host already has, and leaves every
 * earlier kind exactly as it was:
 *
 * - `projectTemplate` is data only: a declarative, texture-free starting
 *   project (see `ProjectTemplatePayload`) the host copies into a new shader
 *   with fresh identities. No Worker, no `code`.
 * - `analyzer` is a Worker contribution. The host sends a copied snapshot of
 *   the open draft plus a host-selected, versioned capability profile; the
 *   Worker answers with bounded findings (`AnalyzerReport`), which the host
 *   validates against the snapshot it sent. Nothing is applied.
 * - `assetTool` is a Worker contribution that names a **host-owned workflow**
 *   (`ASSET_WORKFLOW_IDS`) and the input/output kinds it uses. The host decodes
 *   images to RGBA8 planes and sends those plus validated settings; the Worker
 *   answers with image data, palette data or an effect candidate
 *   (`AssetToolOutput`). Files are encoded and textures assigned in host code
 *   only. A package registers no Angular component: a host adapter, registered
 *   by the app for the workflow, draws the panel.
 *
 * Naming a workflow or a profile selects host code or host data; it grants no
 * network, file or GPU access. Only the ids listed here resolve, and a manifest
 * naming anything else is refused.
 *
 * The call-time validators (`prepareAssetToolInput`, `validateAssetToolOutput`,
 * `validateAnalyzerReport`) live in `tool-calls`.
 */
import type { Preset, RenderSettings, ShaderControl, ShaderParams } from '../model';
import type { ChannelIndex, ShaderProject } from '../project';
import { newId } from '../project/factory';
import { LIMITS } from '../validate/limits';
import { isCleanString, isRecord } from '../validate/primitives';
import { fail, ok, type Result } from '../validate/result';
import type { EffectCandidate } from './package';
import { validateCandidateProject, type ProjectExportChannel } from './project';
import { validateShaderPayload } from '../validate/payload';
import { WALLPAPER_WEB_LIMITS, WALLPAPER_WEB_RUNTIME } from './wallpaper-web';

const KiB = 1024;
const MiB = 1024 * KiB;

/**
 * Quotas of one tool call. Bytes are counted as bytes — a typed-array view
 * counts its own `byteLength`, never its buffer's — and JSON as its UTF-8
 * size. They bound what crosses the Worker boundary, not native memory or GPU
 * time.
 */
export const TOOL_LIMITS = {
  /** RGBA planes one call may carry in. */
  planes: 4,
  /** Largest side of an input plane. */
  planeDimension: 1024,
  /** Largest side of a plane in a preview job. */
  previewDimension: 256,
  /** Raw RGBA bytes of every input plane together. */
  pixelInputBytes: 16 * MiB,
  /** Everything the host sends: pixels plus settings, palette and descriptors. */
  inputBytes: 24 * MiB,
  /** Images one call may return. */
  images: 4,
  /** Largest side of a returned image. */
  imageDimension: 4096,
  /** Raw RGBA bytes of one returned image. */
  imageBytes: 4 * MiB,
  /** Raw RGBA bytes of every returned image together. */
  outputPixelBytes: 16 * MiB,
  /** What the sandbox may decode for an asset tool: the pixels plus a little JSON. */
  outputBytes: 16 * MiB + 128 * KiB,
  /** Operation settings and result metadata, in UTF-8 bytes of JSON. */
  settingsBytes: 64 * KiB,
  metadataBytes: 64 * KiB,
  /** Most an analyzer may be sent: a project snapshot with no texture bytes. */
  analyzerInputBytes: 4 * MiB,
  analyzerOutputBytes: 256 * KiB,
  findings: 100,
  ruleIds: 64,
  messageLength: 300,
  revisionLength: 128,
  paletteColors: 8,
  /** A template's data, in UTF-8 bytes of JSON; the whole package stays under `packageBytes`. */
  templatePayloadBytes: 512 * KiB,
  templateNotes: 8,
  templateNoteLength: 200,
  templateDescriptionLength: 300,
} as const;

// --- Capability profiles ------------------------------------------------------

/**
 * Registered host capability profiles. An analyzer is run against one the host
 * selects, never one it names itself, and a finding is stamped with the
 * profile's version — so a report always says which target it speaks for.
 * Adding a target is a new id here (and an app release), never a package field.
 */
export const CAPABILITY_PROFILE_IDS = ['studio-webgl2/v1', 'wallpaper-web/v1'] as const;
export type CapabilityProfileId = (typeof CAPABILITY_PROFILE_IDS)[number];

export const isCapabilityProfileId = (value: unknown): value is CapabilityProfileId =>
  (CAPABILITY_PROFILE_IDS as readonly unknown[]).includes(value);

export interface CapabilityProfile {
  id: CapabilityProfileId;
  /** The number after `/v` in the id; findings carry it as their `targetVersion`. */
  version: number;
  name: string;
  /** GLSL ES dialect the target compiles: `es300` is WebGL 2, `es100` is WebGL 1. */
  glsl: 'es300' | 'es100';
  limits: {
    passes: number;
    files: number;
    controls: number;
    /** One pass's source, in characters. */
    sourceLength: number;
    textureDimension: number;
    channels: number;
  };
  features: {
    commonPass: boolean;
    /** A buffer sampling the frame it produced last tick. */
    feedback: boolean;
    /** The draft's post-processing chain survives on this target. */
    postProcessing: boolean;
    textures: boolean;
  };
}

export const CAPABILITY_PROFILES: Readonly<Record<CapabilityProfileId, CapabilityProfile>> = {
  'studio-webgl2/v1': {
    id: 'studio-webgl2/v1',
    version: 1,
    name: 'Shadergrove Studio (WebGL 2)',
    glsl: 'es300',
    limits: {
      passes: 8,
      files: 16,
      controls: LIMITS.controlCount,
      sourceLength: LIMITS.sourceLength,
      textureDimension: LIMITS.textureDimension,
      channels: 4,
    },
    features: { commonPass: true, feedback: true, postProcessing: true, textures: true },
  },
  [WALLPAPER_WEB_RUNTIME]: {
    id: WALLPAPER_WEB_RUNTIME,
    version: 1,
    name: 'Wallpaper Engine web wallpaper',
    glsl: 'es100',
    limits: {
      passes: WALLPAPER_WEB_LIMITS.passes,
      files: 16,
      controls: WALLPAPER_WEB_LIMITS.uniforms,
      sourceLength: WALLPAPER_WEB_LIMITS.fragmentLength,
      textureDimension: LIMITS.textureDimension,
      channels: 4,
    },
    features: { commonPass: true, feedback: true, postProcessing: false, textures: true },
  },
};

export function capabilityProfile(id: unknown): CapabilityProfile | null {
  return isCapabilityProfileId(id) ? CAPABILITY_PROFILES[id] : null;
}

// --- Contributions -------------------------------------------------------------

export const ASSET_WORKFLOW_IDS = ['texture-utilities/v1', 'palette-studio/v1'] as const;
export type AssetWorkflowId = (typeof ASSET_WORKFLOW_IDS)[number];

export type AssetInputKind = 'image' | 'palette';
export type AssetOutputKind = 'image' | 'palette' | 'effect';

/** What each host workflow accepts and may return; a contribution declares a subset. */
export const ASSET_WORKFLOWS: Readonly<
  Record<
    AssetWorkflowId,
    { inputs: readonly AssetInputKind[]; outputs: readonly AssetOutputKind[] }
  >
> = {
  'texture-utilities/v1': { inputs: ['image'], outputs: ['image'] },
  'palette-studio/v1': { inputs: ['image', 'palette'], outputs: ['palette', 'effect'] },
};

export const isAssetWorkflowId = (value: unknown): value is AssetWorkflowId =>
  (ASSET_WORKFLOW_IDS as readonly unknown[]).includes(value);

export interface AnalyzerContribution {
  kind: 'analyzer';
  id: string;
  name: string;
  /** The capability profiles this analyzer has rules for; the host runs it against one of them. */
  profiles: CapabilityProfileId[];
}

export interface AssetToolContribution {
  kind: 'assetTool';
  id: string;
  name: string;
  workflow: AssetWorkflowId;
  inputs: AssetInputKind[];
  outputs: AssetOutputKind[];
}

export type TemplateDifficulty = 'beginner' | 'intermediate' | 'advanced';

export interface TemplateProvenance {
  author: string;
  license: string;
  /** Where the idea came from, if anywhere: an https URL. */
  sourceUrl?: string;
}

/** Listing text for a template; its data is `PluginPackage.templates[id]`. */
export interface ProjectTemplateContribution {
  kind: 'projectTemplate';
  id: string;
  name: string;
  description: string;
  difficulty: TemplateDifficulty;
  /** Short things the template teaches, shown beside it. */
  notes: string[];
  provenance: TemplateProvenance;
}

export const analyzerMethod = (id: string): string => `analyzer:${id}`;
export const assetToolMethod = (id: string): string => `assetTool:${id}`;

const ANALYZER_KEYS = ['kind', 'id', 'name', 'profiles'];
const ASSET_TOOL_KEYS = ['kind', 'id', 'name', 'workflow', 'inputs', 'outputs'];
const TEMPLATE_KEYS = ['kind', 'id', 'name', 'description', 'difficulty', 'notes', 'provenance'];
const DIFFICULTIES: readonly TemplateDifficulty[] = ['beginner', 'intermediate', 'advanced'];

type Base = { id: string; name: string };

export function validateToolContributionFields(
  input: Record<string, unknown>,
  at: string,
  base: Base,
): Result<AnalyzerContribution | AssetToolContribution | ProjectTemplateContribution> {
  const kind = input['kind'];
  const known =
    kind === 'analyzer' ? ANALYZER_KEYS : kind === 'assetTool' ? ASSET_TOOL_KEYS : TEMPLATE_KEYS;
  const unknownKey = firstUnknownKey(input, known);
  if (unknownKey) return fail(`${at}.${unknownKey} is not a known field`);

  if (kind === 'analyzer') {
    const profiles = distinctList(input['profiles'], `${at}.profiles`, 1, 8);
    if (!profiles.ok) return profiles;
    for (const profile of profiles.value) {
      if (!isCapabilityProfileId(profile)) {
        return fail(`${at}.profiles "${String(profile)}" is not a registered capability profile`);
      }
    }
    return ok({ ...base, kind, profiles: profiles.value as CapabilityProfileId[] });
  }

  if (kind === 'assetTool') {
    const workflow = input['workflow'];
    if (!isAssetWorkflowId(workflow)) {
      return fail(`${at}.workflow "${String(workflow)}" is not a supported workflow`);
    }
    const allowed = ASSET_WORKFLOWS[workflow];
    const inputs = distinctList(input['inputs'], `${at}.inputs`, 1, 2);
    if (!inputs.ok) return inputs;
    const outputs = distinctList(input['outputs'], `${at}.outputs`, 1, 3);
    if (!outputs.ok) return outputs;
    if (!inputs.value.every((item) => (allowed.inputs as readonly unknown[]).includes(item))) {
      return fail(`${at}.inputs must be among ${allowed.inputs.join(', ')} for ${workflow}`);
    }
    if (!outputs.value.every((item) => (allowed.outputs as readonly unknown[]).includes(item))) {
      return fail(`${at}.outputs must be among ${allowed.outputs.join(', ')} for ${workflow}`);
    }
    return ok({
      ...base,
      kind,
      workflow,
      inputs: inputs.value as AssetInputKind[],
      outputs: outputs.value as AssetOutputKind[],
    });
  }

  const description = input['description'];
  if (
    !isCleanString(description) ||
    description.trim() === '' ||
    description.length > TOOL_LIMITS.templateDescriptionLength
  ) {
    return fail(
      `${at}.description must be 1–${TOOL_LIMITS.templateDescriptionLength} characters of plain text`,
    );
  }
  const difficulty = input['difficulty'];
  if (!DIFFICULTIES.includes(difficulty as TemplateDifficulty)) {
    return fail(`${at}.difficulty must be ${DIFFICULTIES.join(', ')}`);
  }
  const notes = input['notes'] ?? [];
  if (!Array.isArray(notes) || notes.length > TOOL_LIMITS.templateNotes) {
    return fail(`${at}.notes must have at most ${TOOL_LIMITS.templateNotes} entries`);
  }
  for (const note of notes) {
    if (
      !isCleanString(note) ||
      note.trim() === '' ||
      note.length > TOOL_LIMITS.templateNoteLength
    ) {
      return fail(
        `${at}.notes entries must be 1–${TOOL_LIMITS.templateNoteLength} characters of plain text`,
      );
    }
  }
  const provenance = validateProvenance(input['provenance'], `${at}.provenance`);
  if (!provenance.ok) return provenance;
  return ok({
    ...base,
    kind: 'projectTemplate',
    description,
    difficulty: difficulty as TemplateDifficulty,
    notes: notes as string[],
    provenance: provenance.value,
  });
}

function validateProvenance(input: unknown, at: string): Result<TemplateProvenance> {
  if (!isRecord(input)) return fail(`${at} must be an object`);
  const unknownKey = firstUnknownKey(input, ['author', 'license', 'sourceUrl']);
  if (unknownKey) return fail(`${at}.${unknownKey} is not a known field`);
  const result: TemplateProvenance = { author: '', license: '' };
  for (const field of ['author', 'license'] as const) {
    const value = input[field];
    if (!isCleanString(value) || value.trim() === '' || value.length > 64) {
      return fail(`${at}.${field} must be 1–64 characters of plain text`);
    }
    result[field] = value;
  }
  const url = input['sourceUrl'];
  if (url !== undefined) {
    if (typeof url !== 'string' || url.length > 256 || !/^https:\/\/[^\s"'<>]+$/.test(url)) {
      return fail(`${at}.sourceUrl must be an https URL`);
    }
    result.sourceUrl = url;
  }
  return ok(result);
}

// --- Project templates ----------------------------------------------------------

/**
 * A template's data: a texture-free project, its controls (whose `default`s are
 * the starting values), the render settings and optional presets. It is the
 * body of a shader bundle without identity, texture bytes or thumbnail, and it
 * is validated by the same code a bundle is. Nothing in it is executed: no
 * network, asset, lifecycle script or generator parameters.
 */
export interface ProjectTemplatePayload {
  project: ShaderProject;
  controls: ShaderControl[];
  render: RenderSettings;
  presets: Preset[];
}

const PAYLOAD_KEYS = ['project', 'controls', 'render', 'presets'];

/**
 * Validate one template's data against its listing. Strict on shape; textures
 * and dangling pass references are refused rather than quietly dropped, so a
 * template that validates is exactly the project its author wrote.
 */
export function validateTemplatePayload(
  input: unknown,
  contribution: Pick<ProjectTemplateContribution, 'name' | 'description'>,
  at = 'template',
): Result<ProjectTemplatePayload> {
  if (!isRecord(input)) return fail(`${at} must be an object`);
  const unknownKey = firstUnknownKey(input, PAYLOAD_KEYS);
  if (unknownKey) return fail(`${at}.${unknownKey} is not a known field`);
  if (jsonBytes(input) > TOOL_LIMITS.templatePayloadBytes) {
    return fail(`${at} must be at most ${TOOL_LIMITS.templatePayloadBytes} bytes`);
  }

  const raw = input['project'];
  const passes = isRecord(raw) && Array.isArray(raw['passes']) ? raw['passes'] : [];
  const passIds = new Set(passes.map((pass) => (isRecord(pass) ? pass['id'] : undefined)));
  for (const pass of passes) {
    const channels = isRecord(pass) && Array.isArray(pass['channels']) ? pass['channels'] : [];
    for (const binding of channels) {
      if (!isRecord(binding)) continue;
      if (binding['kind'] === 'texture') return fail(`${at}.project must not bind a texture`);
      if (binding['kind'] === 'buffer' && !passIds.has(binding['passId'])) {
        return fail(`${at}.project binds a pass that does not exist`);
      }
    }
  }
  const project = validateCandidateProject(raw);
  if (!project.ok) return fail(...project.errors.map((error) => `${at}: ${error}`));
  // The sanitizer completes a project (a missing Common pass, say, gets a random id) and
  // drops what it cannot keep; a template must already be exactly what it describes.
  const files = isRecord(raw) && Array.isArray(raw['files']) ? raw['files'].length : 0;
  if (project.value.passes.length !== passes.length || project.value.files.length !== files) {
    return fail(
      `${at}.project must be complete: an Image pass, one Common pass, valid buffers and files`,
    );
  }
  const image = project.value.passes.find((pass) => pass.kind === 'image');

  const shader = validateShaderPayload(
    {
      id: 'template',
      name: contribution.name,
      description: contribution.description,
      controls: input['controls'] ?? [],
      render: input['render'],
      presets: input['presets'] ?? [],
      fragment: image?.source ?? '',
      vertex: project.value.vertex,
      project: project.value,
    },
    at,
  );
  if (!shader.ok) return shader;
  if (shader.value.controls.length > LIMITS.controlCount) {
    return fail(`${at}.controls must have at most ${LIMITS.controlCount} entries`);
  }
  return ok({
    project: shader.value.project,
    controls: shader.value.controls,
    render: shader.value.render,
    presets: shader.value.presets,
  });
}

/**
 * A copy of a template with identities of its own: every pass and file gets a
 * new id, every channel binding (feedback ones included) follows the pass it
 * pointed at, and every effect of the chain gets a new instance id. The graph
 * is the template's graph; none of its identities is shared with another
 * instance. `fresh` supplies the ids (default: the app's `newId`).
 */
export function instantiateProjectTemplate(
  payload: ProjectTemplatePayload,
  fresh: (prefix: string) => string = newId,
): ProjectTemplatePayload {
  const copy = JSON.parse(JSON.stringify(payload)) as ProjectTemplatePayload;
  const passes = new Map<string, string>();
  for (const pass of copy.project.passes) passes.set(pass.id, fresh(pass.kind));
  for (const pass of copy.project.passes) {
    pass.id = passes.get(pass.id)!;
    pass.channels = pass.channels.map((binding) =>
      binding.kind === 'buffer'
        ? { ...binding, passId: passes.get(binding.passId) ?? binding.passId }
        : binding,
    ) as unknown as typeof pass.channels;
  }
  for (const file of copy.project.files) file.id = fresh('file');
  for (const effect of copy.render.postProcessing.effects) effect.instanceId = fresh('effect');
  return copy;
}

// --- Palettes -------------------------------------------------------------------

export const PALETTE_FORMAT = 'shadergrove-palette/v1';
export type GradientInterpolation = 'srgb' | 'linear' | 'oklab';
const INTERPOLATIONS: readonly GradientInterpolation[] = ['srgb', 'linear', 'oklab'];
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export interface GradientStop {
  /** 0 to 1; stops are listed in non-decreasing position order. */
  position: number;
  /** `#rrggbb`, sRGB. */
  color: string;
}

/**
 * The palette JSON that moves between the Palette tool, files and effects:
 * `{ "format": "shadergrove-palette/v1", "name", "colors": ["#rrggbb", …],
 * "gradient": { "interpolation", "stops": [{ "position", "color" }] } }`.
 * Colours are opaque sRGB bytes (extraction weighs pixels by alpha but never
 * returns one); at most 8 colours and 8 stops. `gradient` is optional.
 */
export interface PaletteData {
  format: typeof PALETTE_FORMAT;
  name: string;
  /** Ordered, lowercase `#rrggbb`. */
  colors: string[];
  gradient?: { interpolation: GradientInterpolation; stops: GradientStop[] };
}

export function validatePalette(input: unknown, at = 'palette'): Result<PaletteData> {
  if (!isRecord(input)) return fail(`${at} must be an object`);
  const unknownKey = firstUnknownKey(input, ['format', 'name', 'colors', 'gradient']);
  if (unknownKey) return fail(`${at}.${unknownKey} is not a known field`);
  if (input['format'] !== PALETTE_FORMAT) return fail(`${at}.format must be ${PALETTE_FORMAT}`);
  const name = input['name'];
  if (!isCleanString(name) || name.trim() === '' || name.length > LIMITS.nameLength) {
    return fail(`${at}.name must be 1–${LIMITS.nameLength} characters of plain text`);
  }
  const colors = input['colors'] ?? [];
  if (!Array.isArray(colors) || colors.length > TOOL_LIMITS.paletteColors) {
    return fail(`${at}.colors must have at most ${TOOL_LIMITS.paletteColors} entries`);
  }
  for (const color of colors) {
    if (typeof color !== 'string' || !COLOR_PATTERN.test(color)) {
      return fail(`${at}.colors entries must be "#rrggbb"`);
    }
  }
  const palette: PaletteData = {
    format: PALETTE_FORMAT,
    name: name.trim(),
    colors: (colors as string[]).map((color) => color.toLowerCase()),
  };

  const gradient = input['gradient'];
  if (gradient !== undefined) {
    if (!isRecord(gradient)) return fail(`${at}.gradient must be an object`);
    const extra = firstUnknownKey(gradient, ['interpolation', 'stops']);
    if (extra) return fail(`${at}.gradient.${extra} is not a known field`);
    const interpolation = gradient['interpolation'];
    if (!INTERPOLATIONS.includes(interpolation as GradientInterpolation)) {
      return fail(`${at}.gradient.interpolation must be ${INTERPOLATIONS.join(', ')}`);
    }
    const stops = gradient['stops'];
    if (!Array.isArray(stops) || stops.length < 2 || stops.length > TOOL_LIMITS.paletteColors) {
      return fail(`${at}.gradient.stops must have 2 to ${TOOL_LIMITS.paletteColors} entries`);
    }
    const parsed: GradientStop[] = [];
    for (const stop of stops) {
      if (!isRecord(stop) || firstUnknownKey(stop, ['position', 'color'])) {
        return fail(`${at}.gradient.stops entries must be { position, color }`);
      }
      const { position, color } = stop;
      if (
        typeof position !== 'number' ||
        !Number.isFinite(position) ||
        position < 0 ||
        position > 1 ||
        position < (parsed.at(-1)?.position ?? 0)
      ) {
        return fail(`${at}.gradient.stops positions must be 0 to 1 and not decrease`);
      }
      if (typeof color !== 'string' || !COLOR_PATTERN.test(color)) {
        return fail(`${at}.gradient.stops colors must be "#rrggbb"`);
      }
      parsed.push({ position, color: color.toLowerCase() });
    }
    palette.gradient = { interpolation: interpolation as GradientInterpolation, stops: parsed };
  }
  if (palette.colors.length === 0 && !palette.gradient) {
    return fail(`${at} must have colors or a gradient`);
  }
  return ok(palette);
}

// --- Images ---------------------------------------------------------------------

/** Which corner row 0 of the data is: `top-left` is decoded-PNG order, `bottom-left` is GL order. */
export type ImageOrientation = 'top-left' | 'bottom-left';
/** `opaque` promises every alpha byte is 255 — and is checked. */
export type ImageAlpha = 'straight' | 'premultiplied' | 'opaque';
/**
 * `color` is sRGB-encoded picture data; `data` is numeric values (packed
 * channels, normals) no transfer function may touch. Nothing converts between
 * them implicitly.
 */
export type ImageUsage = 'color' | 'data';

export interface RgbaDescriptor {
  width: number;
  height: number;
  orientation: ImageOrientation;
  alpha: ImageAlpha;
  usage: ImageUsage;
}

/** `rgba` is exactly `width × height × 4` bytes, row-major, tightly packed. */
export interface RgbaPlane extends RgbaDescriptor {
  rgba: ArrayBuffer;
}

/** A returned image: a plane the host may encode and offer for download or assignment. */
export interface AssetImageOutput extends RgbaPlane {
  /** A label for the sidecar and the panel; never a path. */
  name: string;
}

export type ToolMetadata = Record<string, unknown>;

export type AssetToolOutput =
  | { kind: 'image'; images: AssetImageOutput[]; metadata: ToolMetadata }
  | { kind: 'palette'; palette: PaletteData; metadata: ToolMetadata }
  | { kind: 'effect'; effect: EffectCandidate; metadata: ToolMetadata };

// --- Analyzer -------------------------------------------------------------------

export type FindingSeverity = 'error' | 'warning' | 'info';
/** `certain` is a fact about the snapshot; `likely` and `possible` are heuristics. */
export type FindingConfidence = 'certain' | 'likely' | 'possible';
/**
 * How the finding was reached. `checked` looked at the source itself,
 * `structural` at the project's shape only (passes, bindings, resources), and
 * `unchecked` records that a rule could not be evaluated — it is not a verdict.
 * A *known unsupported* feature is an `error` that is `checked` or `structural`.
 */
export type FindingCoverage = 'checked' | 'structural' | 'unchecked';

/** A line is 1-based within the document; a binding names a pass's channel with no line at all. */
export type FindingLocation =
  | { kind: 'vertex'; line: number; column?: number }
  | { kind: 'pass'; id: string; line: number; column?: number }
  | { kind: 'file'; id: string; line: number; column?: number }
  | { kind: 'binding'; passId: string; channel: ChannelIndex };

export interface AnalyzerFinding {
  /** Stable, lowercase: `limits.passes`. */
  ruleId: string;
  severity: FindingSeverity;
  message: string;
  confidence: FindingConfidence;
  coverage: FindingCoverage;
  /** The profile version the rule was applied for; always the report's. */
  targetVersion: number;
  location?: FindingLocation;
}

export interface AnalyzerReport {
  profile: CapabilityProfileId;
  targetVersion: number;
  /** Echo of the revision the host sent; a report for another revision is refused. */
  revision: string;
  checkedRules: string[];
  uncheckedRules: string[];
  findings: AnalyzerFinding[];
}

/**
 * What the host observed of one texture slot, from explicit load outcomes — not
 * from whether bytes happen to be stored.
 *
 * - `empty`: the slot has no texture. A verdict.
 * - `loaded`: the texture decoded and is available to the renderer. A verdict.
 * - `loading`: a load is under way.
 * - `failed`: a load settled as a failure (missing, undecodable, rejected).
 * - `unknown`: the host has not observed the slot, or cannot tell.
 *
 * Only `empty` and `loaded` are verdicts. A rule about a slot in any other
 * state cannot be evaluated and must report `coverage: 'unchecked'`; it must
 * neither pass the slot nor claim a fact about it. The host decides how it
 * observes load outcomes; this contract only carries and validates the result.
 */
export const RESOURCE_STATES = ['empty', 'loading', 'loaded', 'failed', 'unknown'] as const;
export type ResourceState = (typeof RESOURCE_STATES)[number];

/** Texture metadata for an analyzer: the exporter's metadata plus the host's load outcome. */
export interface AnalyzerChannel extends ProjectExportChannel {
  state: ResourceState;
}

/**
 * What the host sends an analyzer: a copied snapshot, texture metadata only, and
 * the profile it chose. The whole input, JSON-encoded, is bounded by
 * `TOOL_LIMITS.analyzerInputBytes`.
 */
export interface AnalyzerInput {
  profile: CapabilityProfile;
  /** The host's fingerprint of the source (`sourceFingerprint`) this snapshot was taken from. */
  revision: string;
  name: string;
  project: ShaderProject;
  controls: ShaderControl[];
  params: ShaderParams;
  /** The draft's render settings: the post-processing chain, including custom effects. */
  render: RenderSettings;
  /** One entry per texture slot: metadata and load state, never bytes. */
  channels: AnalyzerChannel[];
  /** Whether the draft's post-processing chain would change the frame. */
  postProcessingActive: boolean;
}

// --- Fingerprint ----------------------------------------------------------------

/**
 * A short, deterministic fingerprint of plain data (keys in sorted order), for
 * telling whether the source an operation started from is still the source now.
 * It is a change detector, not a security hash.
 */
export function sourceFingerprint(value: unknown): string {
  let low = 0x811c9dc5;
  let high = 0x01000193 ^ 0xdeadbeef;
  const feed = (text: string): void => {
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      low = Math.imul(low ^ code, 0x01000193);
      high = Math.imul(high ^ code, 0x85ebca6b);
      high ^= high >>> 13;
    }
  };
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') {
      feed(JSON.stringify(node) ?? 'undefined');
    } else if (Array.isArray(node)) {
      feed('[');
      for (const item of node) {
        walk(item);
        feed(',');
      }
      feed(']');
    } else {
      feed('{');
      for (const key of Object.keys(node).sort()) {
        feed(JSON.stringify(key));
        feed(':');
        walk((node as Record<string, unknown>)[key]);
        feed(',');
      }
      feed('}');
    }
  };
  walk(value);
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  return `fp1:${hex(high)}${hex(low)}`;
}

// --- Helpers --------------------------------------------------------------------

/** UTF-8 bytes of the JSON form, or `Infinity` if it has none. */
export function jsonBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return 0;
    // Counted without TextEncoder, which this library does not assume.
    let bytes = 0;
    for (let index = 0; index < json.length; index++) {
      const code = json.charCodeAt(index);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff) {
        bytes += 4;
        index++;
      } else bytes += 3;
    }
    return bytes;
  } catch {
    return Infinity;
  }
}

function distinctList(input: unknown, at: string, min: number, max: number): Result<unknown[]> {
  if (!Array.isArray(input) || input.length < min || input.length > max) {
    return fail(`${at} must list ${min} to ${max} entries`);
  }
  if (new Set(input).size !== input.length) return fail(`${at} must not repeat an entry`);
  return ok(input);
}

function firstUnknownKey(
  input: Record<string, unknown>,
  known: readonly string[],
): string | undefined {
  return Object.keys(input).find((key) => !known.includes(key));
}
