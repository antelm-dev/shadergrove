/**
 * The call-time half of protocol 4 (`tools`): what the host checks before a
 * tool Worker sees anything, and again before it trusts anything that comes
 * back. Every function is pure and returns a verdict; none of them runs a
 * Worker or touches a file.
 *
 * - `prepareAssetToolInput` validates the host's request, *copies* every plane
 *   into a buffer of its own (so the buffer the host keeps — a preview's only
 *   input, say — is never the one transferred and detached), and counts bytes
 *   as bytes: a typed-array view counts its own `byteLength`.
 * - `validateAssetToolOutput` accepts only the discriminated outputs the
 *   contribution declared, with exact RGBA lengths, bounded images and
 *   metadata, validated palettes and effect candidates. Typed-array views and
 *   objects standing in for buffers are refused: the wire carries
 *   `ArrayBuffer`s, and anything else did not survive it.
 * - `prepareAnalyzerInput` / `validateAnalyzerReport` copy the project snapshot
 *   in and check every finding — including its source location — against that
 *   same snapshot.
 */
import type { ChannelIndex } from '../project';
import { LIMITS } from '../validate/limits';
import { isCleanString, isRecord } from '../validate/primitives';
import type { ShaderParams } from '../model';
import { validateEffectCandidate } from './package';
import { utf8Bytes } from './utf8';
import {
  ASSET_WORKFLOWS,
  TOOL_LIMITS,
  capabilityProfile,
  jsonBytes,
  validatePalette,
  type AnalyzerContribution,
  type AnalyzerFinding,
  type AnalyzerInput,
  type AnalyzerReport,
  type AssetImageOutput,
  type AssetToolContribution,
  type AssetToolOutput,
  type FindingLocation,
  type ImageAlpha,
  type ImageOrientation,
  type ImageUsage,
  type PaletteData,
  type RgbaDescriptor,
  type RgbaPlane,
} from './tools';
import type { ProjectExportChannel } from './project';
import type { ShaderControl } from '../model';
import type { ShaderProject } from '../project';

export type ToolErrorCode =
  | 'input-invalid'
  | 'input-too-large'
  | 'output-invalid'
  | 'output-too-large';

/** A `Result` that also says which limit class failed, so the host can raise the matching error. */
export type ToolResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ToolErrorCode; errors: string[] };

const good = <T>(value: T): ToolResult<T> => ({ ok: true, value });
const bad = (code: ToolErrorCode, message: string): ToolResult<never> => ({
  ok: false,
  code,
  errors: [message],
});

const OPERATION_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const RULE_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/;
const ORIENTATIONS: readonly ImageOrientation[] = ['top-left', 'bottom-left'];
const ALPHAS: readonly ImageAlpha[] = ['straight', 'premultiplied', 'opaque'];
const USAGES: readonly ImageUsage[] = ['color', 'data'];

// --- Bytes ----------------------------------------------------------------------

/** Whether `value` is an `ArrayBuffer`, whichever realm made it. */
export const isArrayBuffer = (value: unknown): value is ArrayBuffer =>
  Object.prototype.toString.call(value) === '[object ArrayBuffer]';

/** Bytes of a buffer or of a view's own window, `null` for anything else (shared memory included). */
export function byteLengthOf(source: unknown): number | null {
  if (isArrayBuffer(source)) return source.byteLength;
  if (ArrayBuffer.isView(source) && isArrayBuffer(source.buffer)) return source.byteLength;
  return null;
}

/** A buffer holding exactly the bytes of `source` — a view's own window, not its whole buffer. */
export function copyBytes(source: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(
      source.buffer as ArrayBuffer,
      source.byteOffset,
      source.byteLength,
    ).slice().buffer;
  }
  return new Uint8Array(source).slice().buffer;
}

/** A plane's raw length: exactly this many bytes, no row padding. */
export const rgbaByteLength = (width: number, height: number): number => width * height * 4;

interface PlaneRules {
  maxDimension: number;
  /** Where a view is acceptable; outputs are `ArrayBuffer`s only. */
  allowViews: boolean;
  /** `too-large` or `invalid` verdict codes for this direction. */
  direction: 'input' | 'output';
}

function checkPlane(
  raw: unknown,
  at: string,
  rules: PlaneRules,
  extraKeys: readonly string[] = [],
): ToolResult<RgbaDescriptor & { rgba: ArrayBuffer | ArrayBufferView }> {
  const invalid: ToolErrorCode = `${rules.direction}-invalid`;
  const large: ToolErrorCode = `${rules.direction}-too-large`;
  if (!isRecord(raw) || isBinary(raw)) return bad(invalid, `${at} must be an object`);
  const known = ['width', 'height', 'orientation', 'alpha', 'usage', 'rgba', ...extraKeys];
  const unknownKey = Object.keys(raw).find((key) => !known.includes(key));
  if (unknownKey) return bad(invalid, `${at}.${unknownKey} is not a known field`);
  const { width, height, orientation, alpha, usage, rgba } = raw;
  for (const [label, value] of [
    ['width', width],
    ['height', height],
  ] as const) {
    if (!Number.isInteger(value) || (value as number) < 1) {
      return bad(invalid, `${at}.${label} must be a positive integer`);
    }
    if ((value as number) > rules.maxDimension) {
      return bad(large, `${at}.${label} must be at most ${rules.maxDimension}`);
    }
  }
  if (!ORIENTATIONS.includes(orientation as ImageOrientation)) {
    return bad(invalid, `${at}.orientation must be ${ORIENTATIONS.join(' or ')}`);
  }
  if (!ALPHAS.includes(alpha as ImageAlpha)) {
    return bad(invalid, `${at}.alpha must be ${ALPHAS.join(', ')}`);
  }
  if (!USAGES.includes(usage as ImageUsage)) {
    return bad(invalid, `${at}.usage must be ${USAGES.join(' or ')}`);
  }
  const bytes = rules.allowViews
    ? byteLengthOf(rgba)
    : isArrayBuffer(rgba)
      ? rgba.byteLength
      : null;
  if (bytes === null) {
    return bad(invalid, `${at}.rgba must be an ArrayBuffer${rules.allowViews ? ' or a view' : ''}`);
  }
  const expected = rgbaByteLength(width as number, height as number);
  if (bytes !== expected) {
    return bad(invalid, `${at}.rgba is ${bytes} bytes; ${width}×${height} RGBA is ${expected}`);
  }
  if (alpha === 'opaque') {
    const view = ArrayBuffer.isView(rgba)
      ? new Uint8Array(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.byteLength)
      : new Uint8Array(rgba as ArrayBuffer);
    for (let index = 3; index < view.length; index += 4) {
      if (view[index] !== 255) return bad(invalid, `${at} is declared opaque but is not`);
    }
  }
  return good({
    width: width as number,
    height: height as number,
    orientation: orientation as ImageOrientation,
    alpha: alpha as ImageAlpha,
    usage: usage as ImageUsage,
    rgba: rgba as ArrayBuffer | ArrayBufferView,
  });
}

/** True for a buffer or view: such a value is never a plain record. */
const isBinary = (value: unknown): boolean => byteLengthOf(value) !== null;

// --- Plain data -------------------------------------------------------------------

/** Plain JSON only: no buffers, views, functions, undefined, non-finite numbers or class instances. */
export function isPlainJson(value: unknown, depth = 0, budget = { nodes: 0 }): boolean {
  if (++budget.nodes > 20_000 || depth > 12) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isPlainJson(item, depth + 1, budget));
  if (typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value).every((item) => isPlainJson(item, depth + 1, budget));
}

function plainRecord(
  value: unknown,
  at: string,
  max: number,
  direction: 'input' | 'output',
): ToolResult<Record<string, unknown>> {
  if (!isRecord(value) || !isPlainJson(value)) {
    return bad(`${direction}-invalid`, `${at} must be a plain JSON object`);
  }
  if (jsonBytes(value) > max)
    return bad(`${direction}-too-large`, `${at} must be at most ${max} bytes`);
  return good(value);
}

// --- Asset tools: input -----------------------------------------------------------

/** One plane as the host holds it: a buffer, or a view over (part of) one. */
export type RgbaSource = RgbaDescriptor & { rgba: ArrayBuffer | ArrayBufferView };

export interface AssetToolRequest {
  operation: string;
  /** Already validated by the workflow's host adapter; bounded and checked as plain JSON here. */
  settings?: unknown;
  planes?: readonly RgbaSource[];
  palette?: unknown;
  /** A preview job: planes are limited to `TOOL_LIMITS.previewDimension`. */
  preview?: boolean;
}

/** What the Worker receives. */
export interface AssetToolInput {
  workflow: AssetToolContribution['workflow'];
  operation: string;
  settings: Record<string, unknown>;
  preview: boolean;
  planes: RgbaPlane[];
  palette?: PaletteData;
}

export interface PreparedAssetToolInput {
  input: AssetToolInput;
  /** The copies' buffers, safe to transfer: the host's own buffers are untouched. */
  transfer: ArrayBuffer[];
  /** Pixel bytes plus JSON bytes: what counted against `TOOL_LIMITS.inputBytes`. */
  bytes: number;
}

export function prepareAssetToolInput(
  contribution: AssetToolContribution,
  request: AssetToolRequest,
): ToolResult<PreparedAssetToolInput> {
  if (typeof request.operation !== 'string' || !OPERATION_PATTERN.test(request.operation)) {
    return bad('input-invalid', 'operation must be a short lowercase identifier');
  }
  const preview = request.preview === true;
  const settings = plainRecord(
    request.settings ?? {},
    'settings',
    TOOL_LIMITS.settingsBytes,
    'input',
  );
  if (!settings.ok) return settings;

  const sources = request.planes ?? [];
  if (sources.length > TOOL_LIMITS.planes) {
    return bad('input-too-large', `at most ${TOOL_LIMITS.planes} planes may be sent`);
  }
  const allowed = ASSET_WORKFLOWS[contribution.workflow];
  if (sources.length > 0 && !contribution.inputs.includes('image')) {
    return bad('input-invalid', `${contribution.name} takes no image input`);
  }
  const maxDimension = preview ? TOOL_LIMITS.previewDimension : TOOL_LIMITS.planeDimension;
  const checked: (RgbaDescriptor & { rgba: ArrayBuffer | ArrayBufferView })[] = [];
  let pixelBytes = 0;
  for (const [index, source] of sources.entries()) {
    const plane = checkPlane(source, `planes[${index}]`, {
      maxDimension,
      allowViews: true,
      direction: 'input',
    });
    if (!plane.ok) return plane;
    pixelBytes += byteLengthOf(plane.value.rgba)!;
    checked.push(plane.value);
  }
  if (pixelBytes > TOOL_LIMITS.pixelInputBytes) {
    return bad('input-too-large', `pixels must be at most ${TOOL_LIMITS.pixelInputBytes} bytes`);
  }

  let palette: PaletteData | undefined;
  if (request.palette !== undefined) {
    if (!contribution.inputs.includes('palette') || !allowed.inputs.includes('palette')) {
      return bad('input-invalid', `${contribution.name} takes no palette input`);
    }
    const parsed = validatePalette(request.palette, 'palette');
    if (!parsed.ok) return bad('input-invalid', parsed.errors[0] ?? 'palette is invalid');
    palette = parsed.value;
  }

  const descriptors = checked.map(({ rgba: _rgba, ...descriptor }) => descriptor);
  const bytes =
    pixelBytes +
    jsonBytes({ operation: request.operation, settings: settings.value, palette, descriptors });
  if (bytes > TOOL_LIMITS.inputBytes) {
    return bad('input-too-large', `input must be at most ${TOOL_LIMITS.inputBytes} bytes`);
  }

  // Copies, after every check: the Worker gets buffers that are the host's no longer.
  const planes: RgbaPlane[] = checked.map((plane) => ({ ...plane, rgba: copyBytes(plane.rgba) }));
  return good({
    input: {
      workflow: contribution.workflow,
      operation: request.operation,
      settings: settings.value,
      preview,
      planes,
      ...(palette ? { palette } : {}),
    },
    transfer: planes.map((plane) => plane.rgba),
    bytes,
  });
}

// --- Asset tools: output ----------------------------------------------------------

const OUTPUT_KEYS: Record<AssetToolOutput['kind'], string[]> = {
  image: ['kind', 'images', 'metadata'],
  palette: ['kind', 'palette', 'metadata'],
  effect: ['kind', 'effect', 'metadata'],
};

export function validateAssetToolOutput(
  raw: unknown,
  contribution: AssetToolContribution,
): ToolResult<AssetToolOutput> {
  if (!isRecord(raw) || isBinary(raw)) return bad('output-invalid', 'tool must return an object');
  const kind = raw['kind'];
  if (kind !== 'image' && kind !== 'palette' && kind !== 'effect') {
    return bad('output-invalid', 'tool output kind must be image, palette or effect');
  }
  if (!contribution.outputs.includes(kind)) {
    return bad('output-invalid', `${contribution.name} does not declare a ${kind} output`);
  }
  const unknownKey = Object.keys(raw).find((key) => !OUTPUT_KEYS[kind].includes(key));
  if (unknownKey) return bad('output-invalid', `output.${unknownKey} is not a known field`);
  const metadata = plainRecord(
    raw['metadata'] ?? {},
    'metadata',
    TOOL_LIMITS.metadataBytes,
    'output',
  );
  if (!metadata.ok) return metadata;

  if (kind === 'palette') {
    const palette = validatePalette(raw['palette'], 'output.palette');
    return palette.ok
      ? good({ kind, palette: palette.value, metadata: metadata.value })
      : bad('output-invalid', palette.errors[0] ?? 'palette is invalid');
  }
  if (kind === 'effect') {
    const effect = validateEffectCandidate(raw['effect']);
    return effect.ok
      ? good({ kind, effect: effect.value, metadata: metadata.value })
      : bad('output-invalid', effect.errors[0] ?? 'effect is invalid');
  }

  const list = raw['images'];
  if (!Array.isArray(list) || list.length === 0) {
    return bad('output-invalid', 'output.images must list at least one image');
  }
  if (list.length > TOOL_LIMITS.images) {
    return bad('output-too-large', `at most ${TOOL_LIMITS.images} images may be returned`);
  }
  const images: AssetImageOutput[] = [];
  let total = 0;
  for (const [index, entry] of list.entries()) {
    const at = `output.images[${index}]`;
    const plane = checkPlane(
      entry,
      at,
      { maxDimension: TOOL_LIMITS.imageDimension, allowViews: false, direction: 'output' },
      ['name'],
    );
    if (!plane.ok) return plane;
    const rgba = plane.value.rgba as ArrayBuffer;
    if (rgba.byteLength > TOOL_LIMITS.imageBytes) {
      return bad('output-too-large', `${at} must be at most ${TOOL_LIMITS.imageBytes} raw bytes`);
    }
    total += rgba.byteLength;
    const name = (entry as Record<string, unknown>)['name'];
    if (!isCleanString(name) || name.trim() === '' || name.length > LIMITS.nameLength) {
      return bad(
        'output-invalid',
        `${at}.name must be 1–${LIMITS.nameLength} characters of plain text`,
      );
    }
    images.push({ ...plane.value, rgba, name: name.trim() });
  }
  if (total > TOOL_LIMITS.outputPixelBytes) {
    return bad(
      'output-too-large',
      `images must total at most ${TOOL_LIMITS.outputPixelBytes} bytes`,
    );
  }
  return good({ kind, images, metadata: metadata.value });
}

// --- Analyzer ---------------------------------------------------------------------

export interface AnalyzerRequest {
  /** Chosen by the host, never by the analyzer; must be one the contribution declares. */
  profileId: unknown;
  revision: string;
  name: string;
  project: ShaderProject;
  controls: readonly ShaderControl[];
  params: ShaderParams;
  channels: readonly ProjectExportChannel[];
  postProcessingActive: boolean;
}

/** A plain-data copy of the snapshot, bounded, stamped with the host-selected profile. */
export function prepareAnalyzerInput(
  contribution: AnalyzerContribution,
  request: AnalyzerRequest,
): ToolResult<AnalyzerInput> {
  const profile = capabilityProfile(request.profileId);
  if (!profile) return bad('input-invalid', 'the capability profile is not registered');
  if (!contribution.profiles.includes(profile.id)) {
    return bad('input-invalid', `${contribution.name} has no rules for ${profile.id}`);
  }
  if (
    typeof request.revision !== 'string' ||
    request.revision === '' ||
    request.revision.length > TOOL_LIMITS.revisionLength
  ) {
    return bad('input-invalid', 'revision must be a short fingerprint string');
  }
  const input = {
    profile,
    revision: request.revision,
    name: request.name,
    project: request.project,
    controls: request.controls,
    params: request.params,
    channels: request.channels,
    postProcessingActive: request.postProcessingActive,
  };
  let json: string;
  try {
    json = JSON.stringify(input);
  } catch {
    return bad('input-invalid', 'the snapshot is not plain JSON data');
  }
  if (utf8Bytes(json) > TOOL_LIMITS.analyzerInputBytes) {
    return bad(
      'input-too-large',
      `snapshot must be at most ${TOOL_LIMITS.analyzerInputBytes} bytes`,
    );
  }
  return good(JSON.parse(json) as AnalyzerInput);
}

const lineCount = (source: string): number => source.split('\n').length;
const lineLength = (source: string, line: number): number =>
  (source.split('\n')[line - 1] ?? '').replace(/\r$/, '').length;

/** A location of a finding, checked against the snapshot the analyzer was sent. */
function validateLocation(
  raw: unknown,
  project: ShaderProject,
  at: string,
): ToolResult<FindingLocation> {
  const invalid = (message: string) => bad('output-invalid', `${at}: ${message}`);
  if (!isRecord(raw)) return invalid('location must be an object');
  const kind = raw['kind'];
  if (kind === 'binding') {
    if (Object.keys(raw).some((key) => !['kind', 'passId', 'channel'].includes(key))) {
      return invalid('a binding location has only passId and channel');
    }
    const { passId, channel } = raw;
    if (!project.passes.some((pass) => pass.id === passId)) {
      return invalid('binding names a pass that is not in the project');
    }
    if (![0, 1, 2, 3].includes(channel as number)) return invalid('binding channel must be 0–3');
    return good({ kind, passId: passId as string, channel: channel as ChannelIndex });
  }

  let source: string | undefined;
  let id: string | undefined;
  if (kind === 'vertex') {
    if (Object.keys(raw).some((key) => !['kind', 'line', 'column'].includes(key))) {
      return invalid('a vertex location has only line and column');
    }
    source = project.vertex;
  } else if (kind === 'pass' || kind === 'file') {
    if (Object.keys(raw).some((key) => !['kind', 'id', 'line', 'column'].includes(key))) {
      return invalid(`a ${kind} location has only id, line and column`);
    }
    id = raw['id'] as string;
    const documents = kind === 'pass' ? project.passes : project.files;
    source = documents.find((document) => document.id === id)?.source;
    if (source === undefined) return invalid(`location names a ${kind} that is not in the project`);
  } else {
    return invalid('location kind must be vertex, pass, file or binding');
  }
  const { line, column } = raw;
  if (!Number.isInteger(line) || (line as number) < 1 || (line as number) > lineCount(source)) {
    return invalid(`line ${String(line)} is outside the document (1–${lineCount(source)})`);
  }
  if (column !== undefined) {
    const length = lineLength(source, line as number);
    if (!Number.isInteger(column) || (column as number) < 1 || (column as number) > length + 1) {
      return invalid(`column ${String(column)} is outside line ${String(line)}`);
    }
  }
  return good({
    kind,
    ...(id === undefined ? {} : { id }),
    line: line as number,
    ...(column === undefined ? {} : { column: column as number }),
  } as FindingLocation);
}

function ruleList(raw: unknown, at: string): ToolResult<string[]> {
  if (!Array.isArray(raw) || raw.length > TOOL_LIMITS.ruleIds) {
    return bad('output-invalid', `${at} must list at most ${TOOL_LIMITS.ruleIds} rules`);
  }
  for (const rule of raw) {
    if (typeof rule !== 'string' || !RULE_PATTERN.test(rule)) {
      return bad('output-invalid', `${at} entries must be rule ids like "limits.passes"`);
    }
  }
  if (new Set(raw).size !== raw.length) return bad('output-invalid', `${at} repeats a rule`);
  return good(raw as string[]);
}

const SEVERITIES = ['error', 'warning', 'info'];
const CONFIDENCES = ['certain', 'likely', 'possible'];
const COVERAGES = ['checked', 'structural', 'unchecked'];

/** Validate an analyzer's reply against the snapshot it was sent. Nothing partly valid is returned. */
export function validateAnalyzerReport(
  raw: unknown,
  input: AnalyzerInput,
): ToolResult<AnalyzerReport> {
  const invalid = (message: string) => bad('output-invalid', message);
  if (!isRecord(raw) || isBinary(raw)) return invalid('analyzer must return an object');
  const unknownKey = Object.keys(raw).find(
    (key) =>
      ![
        'profile',
        'targetVersion',
        'revision',
        'checkedRules',
        'uncheckedRules',
        'findings',
      ].includes(key),
  );
  if (unknownKey) return invalid(`report.${unknownKey} is not a known field`);
  if (raw['profile'] !== input.profile.id)
    return invalid('report is for another capability profile');
  if (raw['targetVersion'] !== input.profile.version) {
    return invalid('report is for another target version');
  }
  if (raw['revision'] !== input.revision) return invalid('report is for another source revision');
  const checkedRules = ruleList(raw['checkedRules'] ?? [], 'report.checkedRules');
  if (!checkedRules.ok) return checkedRules;
  const uncheckedRules = ruleList(raw['uncheckedRules'] ?? [], 'report.uncheckedRules');
  if (!uncheckedRules.ok) return uncheckedRules;

  const list = raw['findings'];
  if (!Array.isArray(list)) return invalid('report.findings must be an array');
  if (list.length > TOOL_LIMITS.findings) {
    return bad('output-too-large', `a report may have at most ${TOOL_LIMITS.findings} findings`);
  }
  const findings: AnalyzerFinding[] = [];
  for (const [index, entry] of list.entries()) {
    const at = `report.findings[${index}]`;
    if (!isRecord(entry)) return invalid(`${at} must be an object`);
    const extra = Object.keys(entry).find(
      (key) =>
        ![
          'ruleId',
          'severity',
          'message',
          'confidence',
          'coverage',
          'targetVersion',
          'location',
        ].includes(key),
    );
    if (extra) return invalid(`${at}.${extra} is not a known field`);
    const { ruleId, severity, message, confidence, coverage, targetVersion, location } = entry;
    if (typeof ruleId !== 'string' || !RULE_PATTERN.test(ruleId)) {
      return invalid(`${at}.ruleId must be a rule id like "limits.passes"`);
    }
    if (!SEVERITIES.includes(severity as string)) return invalid(`${at}.severity is invalid`);
    if (
      !isCleanString(message) ||
      message.trim() === '' ||
      message.length > TOOL_LIMITS.messageLength
    ) {
      return invalid(
        `${at}.message must be 1–${TOOL_LIMITS.messageLength} characters of plain text`,
      );
    }
    if (!CONFIDENCES.includes(confidence as string)) return invalid(`${at}.confidence is invalid`);
    if (!COVERAGES.includes(coverage as string)) return invalid(`${at}.coverage is invalid`);
    if (targetVersion !== input.profile.version) {
      return invalid(`${at}.targetVersion must be ${input.profile.version}`);
    }
    let where: FindingLocation | undefined;
    if (location !== undefined) {
      const parsed = validateLocation(location, input.project, `${at}.location`);
      if (!parsed.ok) return parsed;
      where = parsed.value;
    }
    findings.push({
      ruleId,
      severity: severity as AnalyzerFinding['severity'],
      message: message.trim(),
      confidence: confidence as AnalyzerFinding['confidence'],
      coverage: coverage as AnalyzerFinding['coverage'],
      targetVersion: input.profile.version,
      ...(where ? { location: where } : {}),
    });
  }
  return good({
    profile: input.profile.id,
    targetVersion: input.profile.version,
    revision: input.revision,
    checkedRules: checkedRules.value,
    uncheckedRules: uncheckedRules.value,
    findings,
  });
}
