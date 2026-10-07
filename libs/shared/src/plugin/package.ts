/**
 * The local plugin package: one UTF-8 `.sgplugin.json` file a developer hands
 * to the host. No ZIP, no URL, no external asset, no lifecycle script and no
 * general permission — the manifest declares contributions and nothing else,
 * and an unknown field is refused rather than ignored, so a later protocol
 * cannot be half-read by this one.
 *
 * ```json
 * { "manifest": { "id", "version", "protocolVersion", "appVersionRange",
 *                 "name", "publisher", "license", "contributions": [...] },
 *   "code": "<JS for every Worker contribution, and only then>",
 *   "glsl": { "<effect id>": "<GLSL>" },
 *   "templates": { "<projectTemplate id>": { project, controls, render, presets } } }
 * ```
 *
 * `protocolVersion` (the contract with the host), `appVersionRange` (which app
 * releases the package targets) and `version` (the package's own release) are
 * independent: a package can be valid yet incompatible with this app.
 *
 * Validation happens before anything is activated. An `effect` is declarative
 * (GLSL plus controls the host turns into a pass), and so are a `theme` (colour
 * roles the host maps onto its own tokens — see `themes`), a `language`
 * (messages for the app's own keys — see `languages`) and a `projectTemplate`
 * (a texture-free starting project in `templates` — see `tools`);
 * `importer`/`exporter` and the protocol-4 `analyzer`/`assetTool` are JS run in
 * the plugin Worker. Only the host picks files, builds forms,
 * saves and mutates the project — see `ImporterInput` / `ExporterResult` for the
 * calls.
 */
import type { ShaderControl, ShaderParams } from '../model';
import { sanitizeParams, validateControls } from '../validate/controls';
import { LIMITS } from '../validate/limits';
import { isCleanString, isRecord } from '../validate/primitives';
import { fail, ok, type Result } from '../validate/result';
import { CONTRIBUTION_ID_PATTERN, PACKAGE_ID_PATTERN } from './ids';
import {
  validateProjectContributionFields,
  type ProjectExporterContribution,
  type ProjectImporterContribution,
} from './project';
import { validateLanguageFields, type LanguageContribution } from './languages';
import { validateThemeFields, validateThemeGroups, type ThemeContribution } from './themes';
import {
  validateTemplatePayload,
  validateToolContributionFields,
  type AnalyzerContribution,
  type AssetToolContribution,
  type ProjectTemplateContribution,
  type ProjectTemplatePayload,
} from './tools';
import { utf8Bytes } from './utf8';

export * from './refs';
export * from './themes';
export * from './languages';
export * from './defaults';
export { utf8Bytes } from './utf8';
export * from './project';
export * from './texture-requests';
export * from './wallpaper-web';
export * from './catalogue';
export * from './tools';
export * from './tool-calls';

/** The newest protocol this host speaks. */
export const PLUGIN_PROTOCOL_VERSION = 4;
/**
 * Every protocol this host accepts. Protocol 1 packages keep working
 * unchanged; protocol 2 adds `projectImporter`/`projectExporter` (see `project`);
 * protocol 3 adds `language` and paired themes (theme schema 2); protocol 4
 * adds `analyzer`, `assetTool` and `projectTemplate` (see `tools`). A host that
 * predates a protocol refuses its packages rather than half-reading them.
 */
export const SUPPORTED_PLUGIN_PROTOCOLS: readonly number[] = [1, 2, 3, 4];

const KiB = 1024;
const MiB = 1024 * KiB;

/** Byte limits are UTF-8 bytes for text fields and raw bytes for buffers. */
export const PLUGIN_LIMITS = {
  packageBytes: 1 * MiB,
  manifestBytes: 64 * KiB,
  codeBytes: 512 * KiB,
  glslBytes: 64 * KiB,
  effectControls: 16,
  paramCount: 16,
  contributionCount: 32,
  /** One file handed to an importer. */
  fileBytes: 8 * MiB,
  callInputBytes: 24 * MiB,
  callOutputBytes: 16 * MiB,
  eventBytes: 64 * KiB,
  callEventBytes: 1 * MiB,
  callTimeoutMs: 10_000,
} as const;

export type PluginContributionKind =
  | 'effect'
  | 'importer'
  | 'exporter'
  | 'theme'
  | 'projectImporter'
  | 'projectExporter'
  | 'language'
  | 'analyzer'
  | 'assetTool'
  | 'projectTemplate';

/** The protocol each kind first exists in. */
const KIND_PROTOCOL: Readonly<Record<PluginContributionKind, number>> = {
  effect: 1,
  importer: 1,
  exporter: 1,
  theme: 1,
  projectImporter: 2,
  projectExporter: 2,
  language: 3,
  analyzer: 4,
  assetTool: 4,
  projectTemplate: 4,
};

interface ContributionBase {
  id: string;
  name: string;
}

/** GLSL (in `PluginPackage.glsl[id]`) plus the controls the host builds its UI from. */
export interface EffectContribution extends ContributionBase {
  kind: 'effect';
  controls: ShaderControl[];
}

export interface ImporterContribution extends ContributionBase {
  kind: 'importer';
  /** Lowercase MIME types. A browser may report none, so extensions count too; either one suffices. */
  mime: string[];
  /** Lowercase, with the dot: `.fs`. */
  extensions: string[];
  maxInputBytes: number;
  maxOutputBytes: number;
  /** Form fields the host builds, simple controls only. */
  params: ShaderControl[];
}

export interface ExporterContribution extends ContributionBase {
  kind: 'exporter';
  /** What the exporter produces; the result's MIME must match. */
  mime: string;
  extension: string;
  maxInputBytes: number;
  maxOutputBytes: number;
  params: ShaderControl[];
}

export type PluginContribution =
  | EffectContribution
  | ImporterContribution
  | ExporterContribution
  | ThemeContribution
  | ProjectImporterContribution
  | ProjectExporterContribution
  | LanguageContribution
  | AnalyzerContribution
  | AssetToolContribution
  | ProjectTemplateContribution;

/** The kinds whose work runs as JS in the plugin Worker, and so need `code`. */
export const isCodeContribution = (contribution: PluginContribution): boolean =>
  contribution.kind === 'importer' ||
  contribution.kind === 'exporter' ||
  contribution.kind === 'projectImporter' ||
  contribution.kind === 'projectExporter' ||
  contribution.kind === 'analyzer' ||
  contribution.kind === 'assetTool';

export interface PluginManifest {
  id: string;
  version: string;
  protocolVersion: number;
  /** Space-separated comparators, all of which must hold: `>=1.4.0 <2.0.0`. */
  appVersionRange: string;
  name: string;
  publisher: string;
  license: string;
  contributions: PluginContribution[];
}

export interface PluginPackage {
  manifest: PluginManifest;
  /** JS bundle for the Worker; required when there is a Worker contribution, refused otherwise. */
  code?: string;
  /** GLSL by effect id; exactly one entry per `effect` contribution. */
  glsl: Record<string, string>;
  /** Validated template data by id; exactly one entry per `projectTemplate` contribution. */
  templates: Record<string, ProjectTemplatePayload>;
}

/** What the host sends an importer: the chosen file's bytes and the validated form values. */
export interface ImporterInput {
  bytes: ArrayBuffer;
  params: ShaderParams;
}

/**
 * What an importer returns: a serializable candidate the host revalidates and
 * compiles itself. The Worker never mutates the project.
 */
export interface ImporterResult {
  candidate: unknown;
}

/**
 * An effect a plugin offers the host: an `effect` contribution, or what an
 * importer returns as its `candidate`. Plain data the host revalidates here and
 * compiles before it copies anything into a shader — the shader keeps the copy,
 * whatever becomes of the plugin.
 */
export interface EffectCandidate {
  name: string;
  source: string;
  controls: ShaderControl[];
  values: ShaderParams;
}

const CANDIDATE_KEYS = ['name', 'source', 'controls', 'values'];

/** Validate an effect candidate against the same limits a custom effect is saved under. */
export function validateEffectCandidate(input: unknown): Result<EffectCandidate> {
  if (!isRecord(input)) return fail('effect must be an object');
  const unknownKey = firstUnknownKey(input, CANDIDATE_KEYS);
  if (unknownKey) return fail(`effect.${unknownKey} is not a known field`);
  const name = text(input['name'], 'effect.name');
  if (!name.ok) return name;
  const source = input['source'];
  if (typeof source !== 'string' || source.trim() === '') {
    return fail('effect.source must be non-empty GLSL');
  }
  if (source.length > LIMITS.customEffectSourceLength) {
    return fail(`effect.source must be at most ${LIMITS.customEffectSourceLength} characters`);
  }
  const controls = controlList(
    input['controls'],
    'effect.controls',
    LIMITS.customEffectControlCount,
  );
  if (!controls.ok) return controls;
  return ok({
    name: name.value.trim(),
    source,
    controls: controls.value,
    values: sanitizeParams(controls.value, input['values']),
  });
}

/** The candidate an `effect` contribution stands for: its GLSL, controls and their defaults. */
export function effectContributionCandidate(
  plugin: PluginPackage,
  contribution: EffectContribution,
): EffectCandidate {
  return {
    name: contribution.name,
    source: plugin.glsl[contribution.id] ?? '',
    controls: contribution.controls,
    values: sanitizeParams(contribution.controls, {}),
  };
}

/** What the host sends an exporter: the one chosen effect definition, nothing else of the project. */
export interface ExporterInput {
  effect: unknown;
  params: ShaderParams;
}

/** The host chooses the extension, destination and write; these are only suggestions. */
export interface ExporterResult {
  bytes: ArrayBuffer;
  mime: string;
  fileName: string;
}

export const importerMethod = (id: string): string => `importer:${id}`;
export const exporterMethod = (id: string): string => `exporter:${id}`;

// This library compiles without DOM or Node types; every runtime that loads it has both.
declare const TextDecoder: new (
  label: string,
  options: { fatal: boolean },
) => { decode(bytes: Uint8Array): string };

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;
const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
const EXTENSION_PATTERN = /^\.[a-z0-9]{1,16}$/;
const COMPARATOR_PATTERN = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/;

const MANIFEST_KEYS = [
  'id',
  'version',
  'protocolVersion',
  'appVersionRange',
  'name',
  'publisher',
  'license',
  'contributions',
];
const CONTRIBUTION_KEYS: Record<'effect' | 'importer' | 'exporter', string[]> = {
  effect: ['kind', 'id', 'name', 'controls'],
  importer: [
    'kind',
    'id',
    'name',
    'mime',
    'extensions',
    'maxInputBytes',
    'maxOutputBytes',
    'params',
  ],
  exporter: [
    'kind',
    'id',
    'name',
    'mime',
    'extension',
    'maxInputBytes',
    'maxOutputBytes',
    'params',
  ],
};

/**
 * Read a package from its file bytes (or text). The size limit is applied
 * before the JSON is parsed.
 */
export function parsePluginPackage(input: Uint8Array | string): Result<PluginPackage> {
  const bytes = typeof input === 'string' ? utf8Bytes(input) : input.byteLength;
  if (bytes > PLUGIN_LIMITS.packageBytes) {
    return fail(`package must be at most ${PLUGIN_LIMITS.packageBytes} bytes`);
  }
  let json: unknown;
  try {
    const text =
      typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input);
    json = JSON.parse(text);
  } catch {
    return fail('package is not valid UTF-8 JSON');
  }
  return validatePluginPackage(json);
}

/** Validate a parsed package. Nothing is activated, and nothing partly valid is returned. */
export function validatePluginPackage(input: unknown): Result<PluginPackage> {
  if (!isRecord(input)) return fail('package must be an object');
  const unknownKey = firstUnknownKey(input, ['manifest', 'code', 'glsl', 'templates']);
  if (unknownKey) return fail(`package.${unknownKey} is not a known field`);

  const manifest = validateManifest(input['manifest']);
  if (!manifest.ok) return manifest;

  const code = input['code'];
  if (code !== undefined) {
    if (typeof code !== 'string') return fail('package.code must be a string');
    if (utf8Bytes(code) > PLUGIN_LIMITS.codeBytes) {
      return fail(`package.code must be at most ${PLUGIN_LIMITS.codeBytes} bytes`);
    }
  }
  const needsCode = manifest.value.contributions.some(isCodeContribution);
  if (needsCode && !code) {
    return fail(
      'package.code is required by importer/exporter (and analyzer/assetTool) contributions',
    );
  }
  if (!needsCode && code !== undefined) {
    return fail(
      'package.code is only for importer/exporter (and analyzer/assetTool) contributions',
    );
  }

  const glslInput = input['glsl'] ?? {};
  if (!isRecord(glslInput)) return fail('package.glsl must be an object');
  const effectIds = manifest.value.contributions
    .filter((c) => c.kind === 'effect')
    .map((c) => c.id);
  const glsl: Record<string, string> = {};
  for (const id of Object.keys(glslInput)) {
    if (!effectIds.includes(id)) return fail(`package.glsl["${id}"] has no effect contribution`);
  }
  for (const id of effectIds) {
    const source = glslInput[id];
    if (typeof source !== 'string' || source.trim() === '') {
      return fail(`package.glsl["${id}"] must be non-empty GLSL`);
    }
    if (utf8Bytes(source) > PLUGIN_LIMITS.glslBytes) {
      return fail(`package.glsl["${id}"] must be at most ${PLUGIN_LIMITS.glslBytes} bytes`);
    }
    glsl[id] = source;
  }

  const templates = validateTemplates(input['templates'], manifest.value.contributions);
  if (!templates.ok) return templates;

  return ok({
    manifest: manifest.value,
    ...(code === undefined ? {} : { code }),
    glsl,
    templates: templates.value,
  });
}

/** `package.templates`: exactly one validated payload per `projectTemplate` contribution. */
function validateTemplates(
  input: unknown,
  contributions: readonly PluginContribution[],
): Result<Record<string, ProjectTemplatePayload>> {
  const listed = contributions.filter(
    (c): c is ProjectTemplateContribution => c.kind === 'projectTemplate',
  );
  const raw = input ?? {};
  if (!isRecord(raw)) return fail('package.templates must be an object');
  for (const id of Object.keys(raw)) {
    if (!listed.some((c) => c.id === id)) {
      return fail(`package.templates["${id}"] has no projectTemplate contribution`);
    }
  }
  const templates: Record<string, ProjectTemplatePayload> = {};
  for (const contribution of listed) {
    if (!Object.hasOwn(raw, contribution.id)) {
      return fail(`package.templates["${contribution.id}"] is required`);
    }
    const payload = validateTemplatePayload(
      raw[contribution.id],
      contribution,
      `package.templates["${contribution.id}"]`,
    );
    if (!payload.ok) return payload;
    templates[contribution.id] = payload.value;
  }
  return ok(templates);
}

function validateManifest(input: unknown): Result<PluginManifest> {
  if (!isRecord(input)) return fail('manifest must be an object');
  const unknownKey = firstUnknownKey(input, MANIFEST_KEYS);
  if (unknownKey) return fail(`manifest.${unknownKey} is not a known field`);
  // A language's messages have their own limit (`LANGUAGE_LIMITS`), checked with
  // the rest of it; the manifest limit is for everything else.
  if (utf8Bytes(JSON.stringify(input, withoutMessages)) > PLUGIN_LIMITS.manifestBytes) {
    return fail(`manifest must be at most ${PLUGIN_LIMITS.manifestBytes} bytes`);
  }

  const { id, version, protocolVersion, appVersionRange, contributions } = input;
  if (typeof id !== 'string' || !PACKAGE_ID_PATTERN.test(id)) {
    return fail('manifest.id must be lowercase letters, digits, ".", "_" or "-" (64 max)');
  }
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    return fail('manifest.version must be a semantic version like 1.0.0');
  }
  if (
    typeof protocolVersion !== 'number' ||
    !SUPPORTED_PLUGIN_PROTOCOLS.includes(protocolVersion)
  ) {
    return fail(
      `manifest.protocolVersion ${String(protocolVersion)} is not supported (this app speaks ${SUPPORTED_PLUGIN_PROTOCOLS.join(' and ')})`,
    );
  }
  if (typeof appVersionRange !== 'string' || parseRange(appVersionRange) === null) {
    return fail('manifest.appVersionRange must be comparators like ">=1.4.0 <2.0.0"');
  }
  const name = text(input['name'], 'manifest.name');
  if (!name.ok) return name;
  const publisher = text(input['publisher'], 'manifest.publisher');
  if (!publisher.ok) return publisher;
  const license = text(input['license'], 'manifest.license');
  if (!license.ok) return license;

  if (!Array.isArray(contributions) || contributions.length === 0) {
    return fail('manifest.contributions must be a non-empty array');
  }
  if (contributions.length > PLUGIN_LIMITS.contributionCount) {
    return fail(
      `manifest.contributions must have at most ${PLUGIN_LIMITS.contributionCount} entries`,
    );
  }
  const seen = new Set<string>();
  const parsed: PluginContribution[] = [];
  for (const [index, entry] of contributions.entries()) {
    const result = validateContribution(entry, `manifest.contributions[${index}]`);
    if (!result.ok) return result;
    const needs = Math.max(
      KIND_PROTOCOL[result.value.kind],
      result.value.kind === 'theme' && result.value.schemaVersion === 2 ? 3 : 1,
    );
    if (protocolVersion < needs) {
      const what =
        result.value.kind === 'theme' ? 'theme schemaVersion 2' : `kind "${result.value.kind}"`;
      return fail(`manifest.contributions[${index}]: ${what} needs protocolVersion ${needs}`);
    }
    if (seen.has(result.value.id)) {
      return fail(`manifest.contributions[${index}].id "${result.value.id}" is duplicated`);
    }
    seen.add(result.value.id);
    parsed.push(result.value);
  }
  const groups = validateThemeGroups(parsed);
  if (!groups.ok) return fail(...groups.errors.map((error) => `manifest.contributions: ${error}`));

  return ok({
    id,
    version,
    protocolVersion,
    appVersionRange,
    name: name.value,
    publisher: publisher.value,
    license: license.value,
    contributions: parsed,
  });
}

function validateContribution(input: unknown, at: string): Result<PluginContribution> {
  if (!isRecord(input)) return fail(`${at} must be an object`);
  const kind = input['kind'];
  if (
    kind !== 'effect' &&
    kind !== 'importer' &&
    kind !== 'exporter' &&
    kind !== 'theme' &&
    kind !== 'projectImporter' &&
    kind !== 'projectExporter' &&
    kind !== 'language' &&
    kind !== 'analyzer' &&
    kind !== 'assetTool' &&
    kind !== 'projectTemplate'
  ) {
    return fail(
      `${at}.kind "${String(kind)}" is not supported (effect, importer, exporter, theme, projectImporter, projectExporter, language, analyzer, assetTool or projectTemplate)`,
    );
  }
  if (kind === 'effect' || kind === 'importer' || kind === 'exporter') {
    const unknownKey = firstUnknownKey(input, CONTRIBUTION_KEYS[kind]);
    if (unknownKey) return fail(`${at}.${unknownKey} is not a known field`);
  }

  const id = input['id'];
  if (typeof id !== 'string' || !CONTRIBUTION_ID_PATTERN.test(id)) {
    return fail(`${at}.id must be lowercase letters, digits and "-", starting with a letter`);
  }
  const name = text(input['name'], `${at}.name`);
  if (!name.ok) return name;
  const base = { id, name: name.value };

  if (kind === 'theme') return validateThemeFields(input, at, base);
  if (kind === 'language') return validateLanguageFields(input, at, base);
  if (kind === 'projectImporter' || kind === 'projectExporter') {
    return validateProjectContributionFields(input, at, base);
  }
  if (kind === 'analyzer' || kind === 'assetTool' || kind === 'projectTemplate') {
    return validateToolContributionFields(input, at, base);
  }

  if (kind === 'effect') {
    const controls = controlList(input['controls'], `${at}.controls`, PLUGIN_LIMITS.effectControls);
    return controls.ok ? ok({ ...base, kind, controls: controls.value }) : controls;
  }

  const params = controlList(input['params'], `${at}.params`, PLUGIN_LIMITS.paramCount);
  if (!params.ok) return params;
  const maxInputBytes = bound(input['maxInputBytes'], `${at}.maxInputBytes`, kind);
  if (!maxInputBytes.ok) return maxInputBytes;
  const maxOutputBytes = bound(input['maxOutputBytes'], `${at}.maxOutputBytes`, 'output');
  if (!maxOutputBytes.ok) return maxOutputBytes;
  const limits = { maxInputBytes: maxInputBytes.value, maxOutputBytes: maxOutputBytes.value };

  if (kind === 'exporter') {
    const { mime, extension } = input;
    if (typeof mime !== 'string' || !MIME_PATTERN.test(mime)) {
      return fail(`${at}.mime must be a lowercase MIME type`);
    }
    if (typeof extension !== 'string' || !EXTENSION_PATTERN.test(extension)) {
      return fail(`${at}.extension must be a lowercase extension like ".fs"`);
    }
    return ok({ ...base, kind, mime, extension, ...limits, params: params.value });
  }

  const mime = stringList(input['mime'], `${at}.mime`, MIME_PATTERN);
  if (!mime.ok) return mime;
  const extensions = stringList(input['extensions'], `${at}.extensions`, EXTENSION_PATTERN);
  if (!extensions.ok) return extensions;
  if (mime.value.length + extensions.value.length === 0) {
    return fail(`${at} must accept at least one MIME type or extension`);
  }
  return ok({
    ...base,
    kind,
    mime: mime.value,
    extensions: extensions.value,
    ...limits,
    params: params.value,
  });
}

/** A `JSON.stringify` replacer that leaves a language's messages out of the manifest's size. */
function withoutMessages(this: unknown, key: string, value: unknown): unknown {
  return key === 'messages' && isRecord(this) && this['kind'] === 'language' ? {} : value;
}

function controlList(input: unknown, at: string, max: number): Result<ShaderControl[]> {
  if (Array.isArray(input) && input.length > max) {
    return fail(`${at} must have at most ${max} entries`);
  }
  const result = validateControls(input ?? []);
  return result.ok ? result : fail(...result.errors.map((error) => `${at}: ${error}`));
}

function bound(
  input: unknown,
  at: string,
  kind: 'importer' | 'exporter' | 'output',
): Result<number> {
  const max = kind === 'output' ? PLUGIN_LIMITS.callOutputBytes : PLUGIN_LIMITS.fileBytes;
  if (!Number.isInteger(input) || (input as number) < 1 || (input as number) > max) {
    return fail(`${at} must be an integer from 1 to ${max}`);
  }
  return ok(input as number);
}

function stringList(input: unknown, at: string, pattern: RegExp): Result<string[]> {
  if (input === undefined) return ok([]);
  if (!Array.isArray(input) || input.length > 16)
    return fail(`${at} must be an array of at most 16`);
  for (const item of input) {
    if (typeof item !== 'string' || !pattern.test(item)) return fail(`${at} has an invalid entry`);
  }
  return ok([...new Set(input as string[])]);
}

function text(input: unknown, at: string): Result<string> {
  if (!isCleanString(input) || input.trim() === '' || input.length > 64) {
    return fail(`${at} must be 1–64 characters of plain text`);
  }
  return ok(input);
}

function firstUnknownKey(
  input: Record<string, unknown>,
  known: readonly string[],
): string | undefined {
  return Object.keys(input).find((key) => !known.includes(key));
}

type Triple = [number, number, number];

function triple(version: string): Triple | null {
  const match = VERSION_PATTERN.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compare(a: Triple, b: Triple): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function parseRange(range: string): { op: string; version: Triple }[] | null {
  const parts = range.trim().split(/\s+/);
  if (parts.length === 0 || parts.length > 4) return null;
  const comparators: { op: string; version: Triple }[] = [];
  for (const part of parts) {
    const match = COMPARATOR_PATTERN.exec(part);
    const version = match && triple(match[2]!);
    if (!match || !version) return null;
    comparators.push({ op: match[1] ?? '=', version });
  }
  return comparators;
}

/** Whether the package targets this app release. Independent of `protocolVersion`. */
export function isPluginCompatible(manifest: PluginManifest, appVersion: string): boolean {
  return isAppVersionInRange(manifest.appVersionRange, appVersion);
}

/**
 * Whether `appVersion` satisfies an `appVersionRange` such as `>=1.4.0 <2.0.0`.
 * A beta counts as the release it leads to (`2.0.0-beta.1` as `2.0.0`), so it
 * accepts exactly the plugins that release will.
 */
export function isAppVersionInRange(appVersionRange: string, appVersion: string): boolean {
  const app = triple(appVersion);
  const range = parseRange(appVersionRange);
  if (!app || !range) return false;
  return range.every(({ op, version }) => {
    const order = compare(app, version);
    return (
      (op === '>=' && order >= 0) ||
      (op === '>' && order > 0) ||
      (op === '<=' && order <= 0) ||
      (op === '<' && order < 0) ||
      (op === '=' && order === 0)
    );
  });
}
