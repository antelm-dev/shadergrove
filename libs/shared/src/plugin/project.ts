/**
 * Protocol 2: whole-project contributions.
 *
 * Protocol 1's `importer`/`exporter` move one *effect* in or out. Protocol 2
 * adds `projectImporter` and `projectExporter`, which move a whole shader
 * project, and leaves the protocol-1 kinds exactly as they were: a protocol-2
 * package may still declare them, with the same meaning.
 *
 * The split of work is fixed by the host, not the package:
 *
 * - A `projectImporter` declares which **input modes** the host offers it. In
 *   `paste` mode the host renders a bounded name + text form and sends the
 *   text. In `provider` mode the host runs a named **source provider** (see
 *   `SOURCE_PROVIDER_IDS`): the provider asks for its own inputs — credentials
 *   included — fetches the bounded source document, and sends the Worker that
 *   document and nothing else. Credentials never cross into the Worker.
 * - The Worker answers with a `ProjectCandidate`: plain data plus typed
 *   texture *requests*. The host's provider resolves them (checking each
 *   reference against its own allow-list), and the host builds, validates and
 *   imports the final bundle. Nothing a plugin returns is adopted unchecked.
 * - A `projectExporter` names an **export runtime** (see `EXPORT_RUNTIME_IDS`).
 *   The host snapshots the open draft — texture metadata only, never bytes —
 *   and the Worker maps it to the runtime's data schema. The host runtime
 *   validates that data and alone writes executable files and assets.
 *
 * Only adapter ids listed here resolve; a manifest cannot name anything else,
 * and naming one grants no network or file access — it selects host code.
 */
import type { ShaderControl, ShaderParams, TextureFilterMode, TextureWrapMode } from '../model';
import type { ChannelIndex, ShaderProject } from '../project';
import { sanitizeProject } from '../project/sanitize';
import { DEFAULT_VERTEX } from '../project/defaults';
import { sanitizeParams, validateControls } from '../validate/controls';
import { LIMITS } from '../validate/limits';
import { isCleanString, isRecord } from '../validate/primitives';
import { fail, ok, type Result } from '../validate/result';

const KiB = 1024;
const MiB = 1024 * KiB;

/** Named host source providers a `projectImporter` may use. */
export const SOURCE_PROVIDER_IDS = ['shadertoy-api/v1'] as const;
export type SourceProviderId = (typeof SOURCE_PROVIDER_IDS)[number];

/** Named host export runtimes a `projectExporter` may target. */
export const EXPORT_RUNTIME_IDS = ['wallpaper-web/v1'] as const;
export type ExportRuntimeId = (typeof EXPORT_RUNTIME_IDS)[number];

export const isSourceProviderId = (value: unknown): value is SourceProviderId =>
  (SOURCE_PROVIDER_IDS as readonly unknown[]).includes(value);
export const isExportRuntimeId = (value: unknown): value is ExportRuntimeId =>
  (EXPORT_RUNTIME_IDS as readonly unknown[]).includes(value);

/**
 * Project operation quotas. A project call carries source text and metadata,
 * never texture bytes (those stay with the host on both directions), so these
 * sit well under the effect-call limits of `PLUGIN_LIMITS`.
 */
export const PROJECT_LIMITS = {
  /** Most a contribution may declare for its Worker input. */
  inputBytes: 4 * MiB,
  /** Most a contribution may declare for its Worker reply. */
  outputBytes: 4 * MiB,
  /** Pasted source text, in UTF-8 bytes. */
  pasteBytes: 256 * KiB,
  /** A provider's fetched source document (e.g. Shadertoy's JSON). */
  sourceBytes: 2 * MiB,
  /** Texture requests one candidate may carry, before slot assignment. */
  textureRequests: 16,
  /** Uses (pass + channel) per texture request. */
  textureUses: 20,
  warnings: 32,
  warningLength: 300,
  /** Asset reference string a provider resolves. */
  assetLength: 256,
} as const;

export type ProjectImportMode = 'paste' | 'provider';

export interface ProjectImporterContribution {
  kind: 'projectImporter';
  id: string;
  name: string;
  /** The forms the host offers, in this order. */
  modes: ProjectImportMode[];
  /** Required exactly when `modes` includes `provider`. */
  provider?: SourceProviderId;
  maxInputBytes: number;
  maxOutputBytes: number;
}

export interface ProjectExporterContribution {
  kind: 'projectExporter';
  id: string;
  name: string;
  runtime: ExportRuntimeId;
  maxInputBytes: number;
  maxOutputBytes: number;
}

export const projectImporterMethod = (id: string): string => `projectImporter:${id}`;
export const projectExporterMethod = (id: string): string => `projectExporter:${id}`;

// --- Manifest fields ---------------------------------------------------------

const IMPORTER_KEYS = [
  'kind',
  'id',
  'name',
  'modes',
  'provider',
  'maxInputBytes',
  'maxOutputBytes',
];
const EXPORTER_KEYS = ['kind', 'id', 'name', 'runtime', 'maxInputBytes', 'maxOutputBytes'];

type Base = { id: string; name: string };

export function validateProjectContributionFields(
  input: Record<string, unknown>,
  at: string,
  base: Base,
): Result<ProjectImporterContribution | ProjectExporterContribution> {
  const kind = input['kind'];
  const unknownKey = firstUnknownKey(
    input,
    kind === 'projectImporter' ? IMPORTER_KEYS : EXPORTER_KEYS,
  );
  if (unknownKey) return fail(`${at}.${unknownKey} is not a known field`);
  const maxInputBytes = byteBound(
    input['maxInputBytes'],
    `${at}.maxInputBytes`,
    PROJECT_LIMITS.inputBytes,
  );
  if (!maxInputBytes.ok) return maxInputBytes;
  const maxOutputBytes = byteBound(
    input['maxOutputBytes'],
    `${at}.maxOutputBytes`,
    PROJECT_LIMITS.outputBytes,
  );
  if (!maxOutputBytes.ok) return maxOutputBytes;
  const limits = { maxInputBytes: maxInputBytes.value, maxOutputBytes: maxOutputBytes.value };

  if (kind === 'projectExporter') {
    const runtime = input['runtime'];
    if (!isExportRuntimeId(runtime)) {
      return fail(`${at}.runtime "${String(runtime)}" is not a supported export runtime`);
    }
    return ok({ ...base, kind, runtime, ...limits });
  }

  const modes = input['modes'];
  if (
    !Array.isArray(modes) ||
    modes.length === 0 ||
    modes.length > 2 ||
    new Set(modes).size !== modes.length ||
    !modes.every((mode) => mode === 'paste' || mode === 'provider')
  ) {
    return fail(`${at}.modes must list "paste" and/or "provider" once each`);
  }
  const provider = input['provider'];
  if (modes.includes('provider')) {
    if (!isSourceProviderId(provider)) {
      return fail(`${at}.provider "${String(provider)}" is not a supported source provider`);
    }
  } else if (provider !== undefined) {
    return fail(`${at}.provider is only for the "provider" mode`);
  }
  return ok({
    ...base,
    kind: 'projectImporter',
    modes: modes as ProjectImportMode[],
    ...(provider === undefined ? {} : { provider: provider as SourceProviderId }),
    ...limits,
  });
}

// --- Import ------------------------------------------------------------------

/** What the host sends a `projectImporter`. Never a credential. */
export type ProjectImportInput =
  | { mode: 'paste'; name: string; text: string }
  | { mode: 'provider'; provider: SourceProviderId; sourceId: string; source: unknown };

/** One texture the candidate wants, resolved and slotted by the host's provider. */
export interface ProjectTextureRequest {
  /** A provider-specific reference; the provider refuses anything outside its allow-list. */
  asset: string;
  /** Where it is sampled. The host writes these bindings once the texture has a slot. */
  uses: { passId: string; channel: ChannelIndex }[];
  wrap: TextureWrapMode;
  filter: TextureFilterMode;
  flipY: boolean;
}

export interface ProjectCredits {
  author?: string;
  /** Where the content came from, e.g. `https://www.shadertoy.com/view/XsBSRR`. */
  sourceUrl?: string;
}

/**
 * What a `projectImporter` returns. The project's texture bindings are
 * `none` until the host has resolved `textures`; the rights to the imported
 * content are the content's, whatever the plugin's own licence says.
 */
export interface ProjectCandidate {
  name: string;
  description: string;
  credits: ProjectCredits;
  project: ShaderProject;
  controls: ShaderControl[];
  values: ShaderParams;
  textures: ProjectTextureRequest[];
  warnings: string[];
}

const CANDIDATE_KEYS = [
  'name',
  'description',
  'credits',
  'project',
  'controls',
  'values',
  'textures',
  'warnings',
];
const WRAPS = new Set(['repeat', 'clamp', 'mirror']);

/**
 * Validate a `projectImporter` reply. Strict on shape — unknown fields are
 * refused — and the project goes through the same sanitizer a saved shader
 * does, which also drops any texture binding a plugin wrote itself: textures
 * only ever enter through `textures`, by way of the host's provider.
 */
export function validateProjectCandidate(input: unknown): Result<ProjectCandidate> {
  if (!isRecord(input)) return fail('candidate must be an object');
  const unknownKey = firstUnknownKey(input, CANDIDATE_KEYS);
  if (unknownKey) return fail(`candidate.${unknownKey} is not a known field`);

  const name = plainText(input['name'], 'candidate.name', LIMITS.nameLength, false);
  if (!name.ok) return name;
  const description = boundedText(
    input['description'] ?? '',
    'candidate.description',
    LIMITS.descriptionLength,
  );
  if (!description.ok) return description;
  const credits = validateCredits(input['credits'] ?? {});
  if (!credits.ok) return credits;

  const project = validateCandidateProject(input['project']);
  if (!project.ok) return project;

  const controls = validateControls(input['controls'] ?? []);
  if (!controls.ok) return fail(...controls.errors.map((error) => `candidate.controls: ${error}`));
  if (controls.value.length > LIMITS.controlCount) {
    return fail(`candidate.controls must have at most ${LIMITS.controlCount} entries`);
  }

  const passIds = new Set(project.value.passes.map((pass) => pass.id));
  const textures = validateTextureRequests(input['textures'] ?? [], passIds);
  if (!textures.ok) return textures;
  const warnings = validateWarnings(input['warnings'] ?? [], 'candidate.warnings');
  if (!warnings.ok) return warnings;

  return ok({
    name: name.value.trim(),
    description: description.value.trim(),
    credits: credits.value,
    project: project.value,
    controls: controls.value,
    values: sanitizeParams(controls.value, input['values']),
    textures: textures.value,
    warnings: warnings.value,
  });
}

function validateCredits(input: unknown): Result<ProjectCredits> {
  if (!isRecord(input)) return fail('candidate.credits must be an object');
  const unknownKey = firstUnknownKey(input, ['author', 'sourceUrl']);
  if (unknownKey) return fail(`candidate.credits.${unknownKey} is not a known field`);
  const credits: ProjectCredits = {};
  if (input['author'] !== undefined) {
    const author = plainText(
      input['author'],
      'candidate.credits.author',
      LIMITS.authorLength,
      false,
    );
    if (!author.ok) return author;
    credits.author = author.value.trim();
  }
  if (input['sourceUrl'] !== undefined) {
    const url = input['sourceUrl'];
    if (typeof url !== 'string' || url.length > 256 || !/^https:\/\/[^\s"'<>]+$/.test(url)) {
      return fail('candidate.credits.sourceUrl must be an https URL');
    }
    credits.sourceUrl = url;
  }
  return ok(credits);
}

/**
 * A candidate's project, through the sanitizer a saved shader goes through.
 * Texture bindings are cleared (see `validateProjectCandidate`); a caller that
 * must refuse them instead checks the raw input first.
 */
export function validateCandidateProject(input: unknown): Result<ShaderProject> {
  if (!isRecord(input)) return fail('candidate.project must be an object');
  const passes = input['passes'];
  if (!Array.isArray(passes) || passes.length === 0 || passes.length > 8) {
    return fail('candidate.project.passes must have 1 to 8 entries');
  }
  if (!passes.some((pass) => isRecord(pass) && pass['kind'] === 'image')) {
    return fail('candidate.project must have an Image pass');
  }
  const files = input['files'] ?? [];
  if (!Array.isArray(files) || files.length > 16) {
    return fail('candidate.project.files must have at most 16 entries');
  }
  const sources = [
    input['vertex'],
    ...passes.map((pass) => (isRecord(pass) ? pass['source'] : undefined)),
    ...files.map((file) => (isRecord(file) ? file['source'] : undefined)),
  ];
  for (const source of sources) {
    if (
      source !== undefined &&
      (typeof source !== 'string' || source.length > LIMITS.sourceLength)
    ) {
      return fail(
        `candidate.project sources must be text of at most ${LIMITS.sourceLength} characters`,
      );
    }
  }
  const ids = new Set<string>();
  for (const pass of passes) {
    const id = isRecord(pass) ? pass['id'] : undefined;
    const name = isRecord(pass) ? pass['name'] : undefined;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || ids.has(id)) {
      return fail('candidate.project pass ids must be unique short identifiers');
    }
    if (name !== undefined && !(isCleanString(name) && name.length <= LIMITS.nameLength)) {
      return fail(`candidate.project pass names must be at most ${LIMITS.nameLength} characters`);
    }
    ids.add(id);
  }
  const sanitized = sanitizeProject(input, '', DEFAULT_VERTEX);
  // Textures arrive by request only; a binding the plugin wrote is cleared.
  const passesWithoutTextures = sanitized.passes.map((pass) => ({
    ...pass,
    channels: pass.channels.map((binding) =>
      binding.kind === 'texture' ? { kind: 'none' } : binding,
    ) as unknown as typeof pass.channels,
  }));
  return ok({ ...sanitized, passes: passesWithoutTextures });
}

function validateTextureRequests(
  input: unknown,
  passIds: ReadonlySet<string>,
): Result<ProjectTextureRequest[]> {
  if (!Array.isArray(input) || input.length > PROJECT_LIMITS.textureRequests) {
    return fail(`candidate.textures must have at most ${PROJECT_LIMITS.textureRequests} entries`);
  }
  const requests: ProjectTextureRequest[] = [];
  for (const [index, raw] of input.entries()) {
    const at = `candidate.textures[${index}]`;
    if (!isRecord(raw)) return fail(`${at} must be an object`);
    const unknownKey = firstUnknownKey(raw, ['asset', 'uses', 'wrap', 'filter', 'flipY']);
    if (unknownKey) return fail(`${at}.${unknownKey} is not a known field`);
    const { asset, uses, wrap, filter, flipY } = raw;
    if (!isCleanString(asset) || asset === '' || asset.length > PROJECT_LIMITS.assetLength) {
      return fail(`${at}.asset must be a short reference`);
    }
    if (!Array.isArray(uses) || uses.length === 0 || uses.length > PROJECT_LIMITS.textureUses) {
      return fail(`${at}.uses must have 1 to ${PROJECT_LIMITS.textureUses} entries`);
    }
    const parsedUses: ProjectTextureRequest['uses'] = [];
    for (const use of uses) {
      if (
        !isRecord(use) ||
        typeof use['passId'] !== 'string' ||
        !passIds.has(use['passId']) ||
        ![0, 1, 2, 3].includes(use['channel'] as number) ||
        Object.keys(use).length !== 2
      ) {
        return fail(`${at}.uses must name a pass of the project and a channel 0–3`);
      }
      parsedUses.push({ passId: use['passId'], channel: use['channel'] as ChannelIndex });
    }
    if (typeof wrap !== 'string' || !WRAPS.has(wrap)) return fail(`${at}.wrap is invalid`);
    if (filter !== 'linear' && filter !== 'nearest') return fail(`${at}.filter is invalid`);
    if (typeof flipY !== 'boolean') return fail(`${at}.flipY must be a boolean`);
    requests.push({
      asset,
      uses: parsedUses,
      wrap: wrap as TextureWrapMode,
      filter,
      flipY,
    });
  }
  return ok(requests);
}

// --- Export ------------------------------------------------------------------

/** Texture metadata the exporter sees: never the bytes, which stay with the host. */
export interface ProjectExportChannel {
  present: boolean;
  ext: string | null;
  width: number;
  height: number;
  wrap: TextureWrapMode;
  filter: TextureFilterMode;
  flipY: boolean;
}

/** An immutable snapshot of the open draft, taken when the user asks for the export. */
export interface ProjectExportInput {
  name: string;
  author?: string;
  project: ShaderProject;
  controls: ShaderControl[];
  params: ShaderParams;
  channels: ProjectExportChannel[];
  /** Whether the draft's post-processing chain would change the frame. */
  postProcessingActive: boolean;
}

/** A `projectExporter` reply: runtime data the host runtime validates, plus warnings. */
export interface ProjectExportResult {
  data: unknown;
  warnings: string[];
}

export function validateProjectExportEnvelope(input: unknown): Result<ProjectExportResult> {
  if (!isRecord(input)) return fail('export result must be an object');
  const unknownKey = firstUnknownKey(input, ['data', 'warnings']);
  if (unknownKey) return fail(`export result.${unknownKey} is not a known field`);
  if (!('data' in input)) return fail('export result.data is required');
  const warnings = validateWarnings(input['warnings'] ?? [], 'export result.warnings');
  if (!warnings.ok) return warnings;
  return ok({ data: input['data'], warnings: warnings.value });
}

// --- Helpers -----------------------------------------------------------------

export function validateWarnings(input: unknown, at: string): Result<string[]> {
  if (!Array.isArray(input) || input.length > PROJECT_LIMITS.warnings) {
    return fail(`${at} must have at most ${PROJECT_LIMITS.warnings} entries`);
  }
  for (const warning of input) {
    if (typeof warning !== 'string' || warning.length > PROJECT_LIMITS.warningLength) {
      return fail(
        `${at} entries must be text of at most ${PROJECT_LIMITS.warningLength} characters`,
      );
    }
  }
  return ok(input as string[]);
}

function byteBound(input: unknown, at: string, max: number): Result<number> {
  if (!Number.isInteger(input) || (input as number) < 1 || (input as number) > max) {
    return fail(`${at} must be an integer from 1 to ${max}`);
  }
  return ok(input as number);
}

function plainText(input: unknown, at: string, max: number, allowEmpty: boolean): Result<string> {
  if (!isCleanString(input) || input.length > max || (!allowEmpty && input.trim() === '')) {
    return fail(`${at} must be ${allowEmpty ? 'up to' : '1 to'} ${max} characters of plain text`);
  }
  return ok(input);
}

function boundedText(input: unknown, at: string, max: number): Result<string> {
  if (typeof input !== 'string' || input.length > max) {
    return fail(`${at} must be text of at most ${max} characters`);
  }
  return ok(input);
}

function firstUnknownKey(
  input: Record<string, unknown>,
  known: readonly string[],
): string | undefined {
  return Object.keys(input).find((key) => !known.includes(key));
}
