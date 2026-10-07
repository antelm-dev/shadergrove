/**
 * Calls the Worker contributions of a validated plugin package: importers,
 * exporters, project importers/exporters and the protocol-4 analyzers and asset
 * tools (data-only `projectTemplate`s need no call).
 *
 * The host owns every decision: it checks sizes before anything crosses to the
 * Worker and again before it trusts anything that comes back, hands over only
 * the bytes and form values of one call, and returns data that nothing has
 * applied yet. A failure — oversize, malformed result, timeout, cancellation —
 * rejects and leaves the project and the disk untouched.
 *
 * Each call gets a fresh sandbox, torn down when the call ends, and calls run
 * one at a time, so at most one plugin Worker is alive. Quotas bound bytes and
 * time; they do not bound native memory or GPU time.
 */
import type { ShaderParams } from '@shadergrove/shared/model';
import {
  PLUGIN_LIMITS,
  PROJECT_LIMITS,
  TOOL_LIMITS,
  analyzerMethod,
  assetToolMethod,
  exporterMethod,
  importerMethod,
  projectExporterMethod,
  projectImporterMethod,
  prepareAnalyzerInput,
  prepareAssetToolInput,
  utf8Bytes,
  validateAnalyzerReport,
  validateAssetToolOutput,
  validateProjectCandidate,
  validateProjectExportEnvelope,
  type AnalyzerContribution,
  type AnalyzerReport,
  type AnalyzerRequest,
  type AssetToolContribution,
  type AssetToolOutput,
  type AssetToolRequest,
  type ExporterContribution,
  type ExporterInput,
  type ExporterResult,
  type ImporterContribution,
  type ImporterInput,
  type ImporterResult,
  type PluginPackage,
  type ProjectCandidate,
  type ProjectExportInput,
  type ProjectExportResult,
  type ProjectExporterContribution,
  type ProjectImportInput,
  type ProjectImporterContribution,
  type ToolErrorCode,
} from '@shadergrove/shared/plugin';
import { sanitizeParams } from '@shadergrove/shared/validate';

import {
  PluginCallError,
  PluginSandbox,
  type PluginCallErrorCode,
  type PluginSandboxOptions,
  type SandboxCallOptions,
} from './plugin-sandbox';

export { PluginCallError, type PluginCallErrorCode };

/**
 * The part of `PluginSandbox` the host uses; a test can stand in for it. The
 * sandbox owns the wire format, so it is what bounds reply and event sizes.
 */
export interface SandboxHandle {
  call(method: string, params?: unknown, options?: SandboxCallOptions): Promise<unknown>;
  terminate(reason?: string | Error): Promise<void>;
}

export interface PluginHostOptions {
  /** Shorter than the package limit, never longer; for tests. */
  timeoutMs?: number;
  start?: (code: string, options: PluginSandboxOptions) => Promise<SandboxHandle>;
}

export interface CallOptions {
  signal?: AbortSignal;
}

// One Worker at a time, across every host.
let queue: Promise<unknown> = Promise.resolve();

export class PluginHost {
  private readonly start: NonNullable<PluginHostOptions['start']>;
  private readonly timeoutMs: number;

  constructor(
    readonly plugin: PluginPackage,
    options: PluginHostOptions = {},
  ) {
    this.timeoutMs = Math.min(options.timeoutMs ?? Infinity, PLUGIN_LIMITS.callTimeoutMs);
    this.start = options.start ?? ((code, opts) => PluginSandbox.start(code, opts));
  }

  /** Run an importer on one file's bytes. The buffer is transferred and left detached. */
  async importFile(
    contributionId: string,
    bytes: ArrayBuffer,
    params: ShaderParams = {},
    options: CallOptions = {},
  ): Promise<ImporterResult> {
    const contribution = this.contribution(contributionId, 'importer');
    if (bytes.byteLength > PLUGIN_LIMITS.fileBytes) {
      throw new PluginCallError('input-too-large', 'File is larger than a plugin may read');
    }
    if (bytes.byteLength > contribution.maxInputBytes) {
      throw new PluginCallError(
        'input-too-large',
        `File exceeds ${contribution.name}'s input limit`,
      );
    }
    const input: ImporterInput = { bytes, params: sanitizeParams(contribution.params, params) };
    // The params ride along with the file, so they count against the same limit.
    const total = bytes.byteLength + utf8Bytes(JSON.stringify(input.params));
    if (total > Math.min(contribution.maxInputBytes, PLUGIN_LIMITS.callInputBytes)) {
      throw new PluginCallError('input-too-large', 'Input exceeds the importer limit');
    }
    const result = await this.run(
      importerMethod(contributionId),
      input,
      [bytes],
      contribution.maxOutputBytes,
      options,
    );
    if (!isObject(result) || !('candidate' in result)) {
      throw new PluginCallError('output-invalid', 'Importer must return { candidate }');
    }
    return { candidate: result['candidate'] };
  }

  /** Run an exporter on the one effect definition chosen; nothing else of the project goes in. */
  async exportEffect(
    contributionId: string,
    effect: unknown,
    params: ShaderParams = {},
    options: CallOptions = {},
  ): Promise<ExporterResult> {
    const contribution = this.contribution(contributionId, 'exporter');
    const input: ExporterInput = {
      effect: jsonCopy(effect, contribution.maxInputBytes),
      params: sanitizeParams(contribution.params, params),
    };
    // The params travel with the effect, so the whole input counts against the limit.
    if (serializedBytes(input)! > contribution.maxInputBytes) {
      throw new PluginCallError('input-too-large', 'Input exceeds the exporter limit');
    }
    const result = await this.run(
      exporterMethod(contributionId),
      input,
      [],
      contribution.maxOutputBytes,
      options,
    );
    return validateExport(result, contribution);
  }

  /**
   * Run a `projectImporter` on one host-rendered input: pasted text, or the
   * source document a host provider fetched. The input is a plain-data copy
   * bounded before it crosses; credentials are never part of it. The reply is
   * validated here — a malformed candidate rejects, and nothing is adopted.
   */
  async importProject(
    contributionId: string,
    input: ProjectImportInput,
    options: CallOptions = {},
  ): Promise<ProjectCandidate> {
    const contribution = this.contribution(contributionId, 'projectImporter');
    if (!contribution.modes.includes(input.mode)) {
      throw new PluginCallError('input-invalid', `${contribution.name} has no ${input.mode} mode`);
    }
    let sent: ProjectImportInput;
    if (input.mode === 'paste') {
      if (typeof input.text !== 'string' || utf8Bytes(input.text) > PROJECT_LIMITS.pasteBytes) {
        throw new PluginCallError(
          'input-too-large',
          'Pasted text is larger than a plugin may read',
        );
      }
      sent = { mode: 'paste', name: String(input.name ?? '').slice(0, 64), text: input.text };
    } else {
      if (input.provider !== contribution.provider) {
        throw new PluginCallError(
          'input-invalid',
          `${contribution.name} does not use that provider`,
        );
      }
      const source = jsonCopy(input.source, PROJECT_LIMITS.sourceBytes);
      sent = {
        mode: 'provider',
        provider: input.provider,
        sourceId: String(input.sourceId).slice(0, 128),
        source,
      };
    }
    const size = serializedBytes(sent)!;
    if (size > Math.min(contribution.maxInputBytes, PLUGIN_LIMITS.callInputBytes)) {
      throw new PluginCallError('input-too-large', 'Input exceeds the importer limit');
    }
    const result = await this.run(
      projectImporterMethod(contributionId),
      sent,
      [],
      contribution.maxOutputBytes,
      options,
    );
    const candidate = validateProjectCandidate(result);
    if (!candidate.ok) {
      throw new PluginCallError('output-invalid', candidate.errors[0] ?? 'Invalid project');
    }
    return candidate.value;
  }

  /**
   * Run a `projectExporter` on a snapshot of the draft. Texture bytes stay
   * here: the snapshot carries their metadata only. The reply's `data` is the
   * runtime's to validate; only its envelope is checked here.
   */
  async exportProject(
    contributionId: string,
    snapshot: ProjectExportInput,
    options: CallOptions = {},
  ): Promise<ProjectExportResult> {
    const contribution = this.contribution(contributionId, 'projectExporter');
    const input = jsonCopy(
      snapshot,
      Math.min(contribution.maxInputBytes, PLUGIN_LIMITS.callInputBytes),
    );
    const result = await this.run(
      projectExporterMethod(contributionId),
      input,
      [],
      contribution.maxOutputBytes,
      options,
    );
    const envelope = validateProjectExportEnvelope(result);
    if (!envelope.ok) {
      throw new PluginCallError('output-invalid', envelope.errors[0] ?? 'Invalid export');
    }
    return envelope.value;
  }

  /**
   * Run an `analyzer` on a copied snapshot of the draft, against a capability
   * profile the host chose. The reply is validated against that very snapshot
   * — profile, version, revision and every source location — and returned
   * unapplied; nothing else of the project crosses.
   */
  async analyze(
    contributionId: string,
    request: AnalyzerRequest,
    options: CallOptions = {},
  ): Promise<AnalyzerReport> {
    const contribution = this.contribution(contributionId, 'analyzer');
    const prepared = prepareAnalyzerInput(contribution, request);
    if (!prepared.ok) throw toolError(prepared);
    const result = await this.run(
      analyzerMethod(contributionId),
      prepared.value,
      [],
      TOOL_LIMITS.analyzerOutputBytes,
      options,
    );
    const report = validateAnalyzerReport(result, prepared.value);
    if (!report.ok) throw toolError(report);
    return report.value;
  }

  /**
   * Run an `assetTool` on host-decoded RGBA planes. Every plane is copied
   * before it is transferred, so the buffers the caller keeps are never
   * detached; the reply is one of the output kinds the contribution declared,
   * validated here and returned unapplied. Encoding, download and assignment
   * are the caller's, in host code.
   */
  async runAssetTool(
    contributionId: string,
    request: AssetToolRequest,
    options: CallOptions = {},
  ): Promise<AssetToolOutput> {
    const contribution = this.contribution(contributionId, 'assetTool');
    const prepared = prepareAssetToolInput(contribution, request);
    if (!prepared.ok) throw toolError(prepared);
    const result = await this.run(
      assetToolMethod(contributionId),
      prepared.value.input,
      prepared.value.transfer,
      TOOL_LIMITS.outputBytes,
      options,
    );
    const output = validateAssetToolOutput(result, contribution);
    if (!output.ok) throw toolError(output);
    return output.value;
  }

  private contribution(id: string, kind: 'importer'): ImporterContribution;
  private contribution(id: string, kind: 'exporter'): ExporterContribution;
  private contribution(id: string, kind: 'projectImporter'): ProjectImporterContribution;
  private contribution(id: string, kind: 'projectExporter'): ProjectExporterContribution;
  private contribution(id: string, kind: 'analyzer'): AnalyzerContribution;
  private contribution(id: string, kind: 'assetTool'): AssetToolContribution;
  private contribution(
    id: string,
    kind:
      | 'importer'
      | 'exporter'
      | 'projectImporter'
      | 'projectExporter'
      | 'analyzer'
      | 'assetTool',
  ) {
    const found = this.plugin.manifest.contributions.find((c) => c.id === id && c.kind === kind);
    if (!found || !this.plugin.code) {
      throw new PluginCallError('unknown-contribution', `No ${kind} "${id}" in this package`);
    }
    return found;
  }

  private run(
    method: string,
    params: unknown,
    transfer: Transferable[],
    maxOutputBytes: number,
    { signal }: CallOptions,
  ): Promise<unknown> {
    const turn = queue.then(() => this.runOnce(method, params, transfer, maxOutputBytes, signal));
    queue = turn.catch(() => undefined);
    return turn;
  }

  private async runOnce(
    method: string,
    params: unknown,
    transfer: Transferable[],
    maxOutputBytes: number,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const cancelled = () => new PluginCallError('cancelled', 'Call was cancelled');
    if (signal?.aborted) throw cancelled();
    let sandbox: SandboxHandle | undefined;
    const cancel = () => void sandbox?.terminate(cancelled());
    try {
      sandbox = await this.start(this.plugin.code!, {});
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      return await sandbox.call(method, params, {
        timeoutMs: this.timeoutMs,
        transfer,
        maxResultBytes: maxOutputBytes,
      });
    } finally {
      signal?.removeEventListener('abort', cancel);
      await sandbox?.terminate('Call finished');
    }
  }
}

/** A shared verdict as the error a call raises. */
const toolError = (failure: { code: ToolErrorCode; errors: string[] }): PluginCallError =>
  new PluginCallError(failure.code, failure.errors[0] ?? 'Invalid tool call');

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** UTF-8 size of the JSON form, or `null` if it has none (cycles, BigInt). */
function serializedBytes(value: unknown): number | null {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : utf8Bytes(json);
  } catch {
    return null;
  }
}

/** A plain-data copy of what the app hands a plugin, bounded before it is sent. */
function jsonCopy(value: unknown, max: number): unknown {
  const size = serializedBytes(value);
  if (size === null) throw new PluginCallError('input-invalid', 'Value is not plain JSON data');
  if (size > max) {
    throw new PluginCallError('input-too-large', `Value is ${size} bytes; the limit is ${max}`);
  }
  return JSON.parse(JSON.stringify(value));
}

function validateExport(result: unknown, contribution: ExporterContribution): ExporterResult {
  if (!isObject(result))
    throw new PluginCallError('output-invalid', 'Exporter must return an object');
  const { bytes, mime, fileName } = result;
  if (!(bytes instanceof ArrayBuffer)) {
    throw new PluginCallError('output-invalid', 'Exporter bytes must be an ArrayBuffer');
  }
  if (mime !== contribution.mime) {
    throw new PluginCallError('output-invalid', `Exporter must produce ${contribution.mime}`);
  }
  // The suggestion is a leaf name; the host picks the real destination.
  // oxlint-disable-next-line no-control-regex
  if (typeof fileName !== 'string' || !/^[^\\/:*?"<>|\u0000-\u001f]{1,128}$/.test(fileName)) {
    throw new PluginCallError('output-invalid', 'Exporter fileName must be a plain file name');
  }
  return { bytes, mime, fileName };
}
