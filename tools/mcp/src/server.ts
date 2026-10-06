import { pathToFileURL } from 'node:url';

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import {
  COMMAND_SCHEMAS,
  CompileResultSchema,
  DocumentSnapshotSchema,
  McpDiagnosticSchema,
  McpErrorSchema,
  McpScreenshotSchema,
  McpStateSnapshotSchema,
  PatchResultSchema,
  ProjectSnapshotSchema,
  RenderFrameResultSchema,
  SetParamsResultSchema,
  mcpError,
  type McpError,
} from '@shadergrove/shared/mcp-protocol';
import type { ShadergroveController } from '@shadergrove/shared/controller';

import { installBridgeShutdown, McpBridgeError, startBridge } from './bridge.js';
import { ConfigError, loadConfig } from './config.js';
import { BridgeController } from './controller.js';
import { createLogger } from './logger.js';

function toMcpError(error: unknown): McpError {
  if (error instanceof McpBridgeError) return error.mcpError;
  return mcpError('INTERNAL', error instanceof Error ? error.message : String(error));
}

function errorResult(error: unknown): CallToolResult {
  const problem = toMcpError(error);
  return {
    content: [{ type: 'text', text: `${problem.code}: ${problem.message}` }],
    isError: true,
  };
}

async function handle<T>(
  work: () => Promise<T>,
  onSuccess: (value: T) => CallToolResult,
): Promise<CallToolResult> {
  try {
    return onSuccess(await work());
  } catch (error) {
    return errorResult(error);
  }
}

function text(value: string): CallToolResult['content'][number] {
  return { type: 'text', text: value };
}

function resourceLink(
  uri: string,
  name: string,
  mimeType?: string,
): CallToolResult['content'][number] {
  return { type: 'resource_link', uri, name, ...(mimeType ? { mimeType } : {}) };
}

// ---------------------------------------------------------------------------
// Resource URIs
// ---------------------------------------------------------------------------

const libraryUri = () => 'shader-studio://library';
const projectUri = (shaderId: string) => `shader-studio://shaders/${shaderId}/project`;
const documentUri = (shaderId: string, documentId: string) =>
  `shader-studio://shaders/${shaderId}/documents/${documentId}`;
const diagnosticsUri = (shaderId: string) => `shader-studio://shaders/${shaderId}/diagnostics`;
const previewUri = (shaderId: string) => `shader-studio://shaders/${shaderId}/preview.png`;

const readOnly: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/**
 * Registers every tool and resource against `controller` and hands back the
 * server, unconnected. Split from `main()` so tests can wire it to an
 * `InMemoryTransport` and a fake `ShadergroveController` instead of a real
 * bridge and stdio.
 */
export function buildServer(controller: ShadergroveController): McpServer {
  const server = new McpServer(
    { name: 'shadergrove', version: '1.0.0' },
    {
      instructions:
        'Contrôle une session Shadergrove ouverte dans le navigateur. ' +
        'Lance `pnpm dev` (ou ouvre l’app packagée), colle le token du bridge ' +
        '(`localStorage.setItem("shaderStudioMcpToken", "…")`) puis édite les shaders live, ' +
        'règle les uniforms et capture le canvas. Un seul onglet à la fois. ' +
        'Préfère `get_project`/`get_document`/`apply_shader_patch` aux outils historiques ' +
        "`set_fragment`/`set_vertex`, qui ne connaissent qu'un seul fragment shader.",
    },
  );

  // ---------------------------------------------------------------------------
  // Existing tools — kept, now with structured output.
  // ---------------------------------------------------------------------------

  server.registerTool(
    'list_shaders',
    {
      description: 'Liste les shaders de la bibliothèque (résumé, sans le code source).',
      outputSchema: { shaders: COMMAND_SCHEMAS.listShaders.result },
      annotations: readOnly,
    },
    async () =>
      handle(
        () => controller.listShaders(),
        (shaders) => ({
          content: [text(`${shaders.length} shader(s).`), resourceLink(libraryUri(), 'library')],
          structuredContent: { shaders },
        }),
      ),
  );

  server.registerTool(
    'select_shader',
    {
      description: 'Ouvre un shader par son id.',
      inputSchema: { shaderId: z.string().describe('Identifiant du shader') },
      outputSchema: McpStateSnapshotSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ shaderId }) =>
      handle(
        () => controller.selectShader(shaderId),
        (state) => ({
          content: [text(`Shader "${shaderId}" ouvert.`)],
          structuredContent: state,
        }),
      ),
  );

  server.registerTool(
    'get_state',
    {
      description: 'Snapshot complet : draft, params live, presets, diagnostics, état dirty/saved.',
      outputSchema: McpStateSnapshotSchema.shape,
      annotations: readOnly,
    },
    async () =>
      handle(
        () => controller.getState(),
        (state) => ({
          content: [text(state.selectedId ?? 'Aucun shader sélectionné.')],
          structuredContent: state,
        }),
      ),
  );

  server.registerTool(
    'set_fragment',
    {
      title: 'Compatibility tool — prefer apply_shader_patch',
      description:
        'Outil de compatibilité : remplace le fragment shader courant (recompile après ~400 ms). ' +
        "Ne connaît que le pass Image d'un projet mono-shader — préfère `apply_shader_patch`.",
      inputSchema: { code: z.string().describe('Source GLSL du fragment shader') },
      outputSchema: { diagnostics: COMMAND_SCHEMAS.setFragment.result },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ code }) =>
      handle(
        () => controller.setFragment(code),
        (diagnostics) => ({
          content: [text(`${diagnostics.length} diagnostic(s).`)],
          structuredContent: { diagnostics },
        }),
      ),
  );

  server.registerTool(
    'set_vertex',
    {
      title: 'Compatibility tool — prefer apply_shader_patch',
      description:
        'Outil de compatibilité : remplace le vertex shader courant (recompile après ~400 ms). ' +
        'Préfère `apply_shader_patch` sur le document `@vertex`.',
      inputSchema: { code: z.string().describe('Source GLSL du vertex shader') },
      outputSchema: { diagnostics: COMMAND_SCHEMAS.setVertex.result },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ code }) =>
      handle(
        () => controller.setVertex(code),
        (diagnostics) => ({
          content: [text(`${diagnostics.length} diagnostic(s).`)],
          structuredContent: { diagnostics },
        }),
      ),
  );

  server.registerTool(
    'set_controls',
    {
      description: 'Remplace le schéma JSON des contrôles/uniforms (onglet Config).',
      inputSchema: { text: z.string().describe('JSON du schéma de contrôles') },
      outputSchema: { diagnostics: COMMAND_SCHEMAS.setControls.result },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ text: controlsText }) =>
      handle(
        () => controller.setControls(controlsText),
        (diagnostics) => ({
          content: [text(`${diagnostics.length} diagnostic(s).`)],
          structuredContent: { diagnostics },
        }),
      ),
  );

  server.registerTool(
    'set_param',
    {
      description: 'Règle un uniform live sans sauvegarder le shader.',
      inputSchema: {
        key: z.string().describe('Clé du contrôle (pas le nom uniform u_*)'),
        value: COMMAND_SCHEMAS.setParam.payload.shape.value.describe(
          'Valeur : number, boolean ou string (couleur hex)',
        ),
      },
      outputSchema: { params: COMMAND_SCHEMAS.setParam.result },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ key, value }) =>
      handle(
        () => controller.setParam(key, value),
        (params) => ({
          content: [text(`${key} = ${String(value)}`)],
          structuredContent: { params },
        }),
      ),
  );

  server.registerTool(
    'reset_params',
    {
      description: 'Remet tous les uniforms aux valeurs par défaut du schéma.',
      outputSchema: { params: COMMAND_SCHEMAS.resetParams.result },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      handle(
        () => controller.resetParams(),
        (params) => ({
          content: [text('Paramètres réinitialisés.')],
          structuredContent: { params },
        }),
      ),
  );

  server.registerTool(
    'list_presets',
    {
      description: 'Liste les presets du shader ouvert.',
      outputSchema: { presets: COMMAND_SCHEMAS.listPresets.result },
      annotations: readOnly,
    },
    async () =>
      handle(
        () => controller.listPresets(),
        (presets) => ({
          content: [text(`${presets.length} preset(s).`)],
          structuredContent: { presets },
        }),
      ),
  );

  server.registerTool(
    'apply_preset',
    {
      description: 'Applique un preset (params + éventuellement render settings).',
      inputSchema: { presetId: z.string().describe('Identifiant du preset') },
      outputSchema: McpStateSnapshotSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ presetId }) =>
      handle(
        () => controller.applyPreset(presetId),
        (state) => ({
          content: [text(`Preset "${presetId}" appliqué.`)],
          structuredContent: state,
        }),
      ),
  );

  server.registerTool(
    'save_preset',
    {
      description: 'Capture les params live actuels dans un nouveau preset.',
      inputSchema: {
        name: z.string().describe('Nom du preset'),
        withRender: z
          .boolean()
          .optional()
          .describe('Inclure aussi les render settings (bloom) du draft'),
      },
      outputSchema: { presets: COMMAND_SCHEMAS.savePreset.result },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ name, withRender }) =>
      handle(
        () => controller.savePreset(name, withRender),
        (presets) => ({
          content: [text(`Preset "${name}" sauvegardé.`)],
          structuredContent: { presets },
        }),
      ),
  );

  server.registerTool(
    'delete_preset',
    {
      description: 'Supprime un preset persisté.',
      inputSchema: { presetId: z.string().describe('Identifiant du preset') },
      outputSchema: { presets: COMMAND_SCHEMAS.deletePreset.result },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ presetId }) =>
      handle(
        () => controller.deletePreset(presetId),
        (presets) => ({
          content: [text(`Preset "${presetId}" supprimé.`)],
          structuredContent: { presets },
        }),
      ),
  );

  server.registerTool(
    'save',
    {
      description: 'Sauvegarde le draft courant sur disque (Ctrl+S). Écrase la version persistée.',
      outputSchema: McpStateSnapshotSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      handle(
        () => controller.saveProject(),
        (state) => ({ content: [text('Draft sauvegardé.')], structuredContent: state }),
      ),
  );

  server.registerTool(
    'revert',
    {
      description: 'Annule les modifications non sauvegardées du draft. Irréversible.',
      outputSchema: McpStateSnapshotSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () =>
      handle(
        () => controller.revert(),
        (state) => ({ content: [text('Draft annulé.')], structuredContent: state }),
      ),
  );

  server.registerTool(
    'get_diagnostics',
    {
      description: 'Diagnostics de compilation (fragment, vertex, config) du draft courant.',
      outputSchema: { diagnostics: COMMAND_SCHEMAS.getDiagnostics.result },
      annotations: readOnly,
    },
    async () =>
      handle(
        () => controller.getDiagnostics(),
        (diagnostics) => ({
          content: [text(`${diagnostics.length} diagnostic(s).`)],
          structuredContent: { diagnostics },
        }),
      ),
  );

  server.registerTool(
    'screenshot',
    {
      description: "Capture le rendu WebGL actuel en PNG (l'image telle qu'elle est affichée).",
      outputSchema: McpScreenshotSchema.shape,
      annotations: readOnly,
    },
    async () =>
      handle(
        () => controller.screenshot(),
        (frame) => ({
          content: [
            { type: 'image', data: frame.base64, mimeType: frame.mimeType },
            text('Capture du rendu shader actuel.'),
          ],
          structuredContent: frame,
        }),
      ),
  );

  // ---------------------------------------------------------------------------
  // Project-aware tools
  // ---------------------------------------------------------------------------

  server.registerTool(
    'get_project',
    {
      description:
        'Projet complet du shader sélectionné : passes, fichiers, contrôles, paramètres, presets, ' +
        'render settings, diagnostics, état dirty et revision. Les sources ne sont pas incluses ' +
        '(voir `get_document`) — seuls le nom, le type et la longueur de chaque document le sont.',
      inputSchema: {
        shaderId: z
          .string()
          .optional()
          .describe('Optionnel : doit correspondre au shader sélectionné, sinon NOT_FOUND'),
      },
      outputSchema: ProjectSnapshotSchema.shape,
      annotations: readOnly,
    },
    async ({ shaderId }) =>
      handle(
        () => controller.getProject(shaderId),
        (project) => ({
          content: [
            text(
              `"${project.name}" — revision ${project.revision}, ${project.documents.length} document(s)` +
                `${project.dirty ? ', unsaved changes' : ''}${project.hasErrors ? ', has errors' : ''}.`,
            ),
            resourceLink(
              projectUri(project.shaderId),
              `${project.name} project`,
              'application/json',
            ),
            resourceLink(previewUri(project.shaderId), `${project.name} preview`, 'image/png'),
          ],
          structuredContent: project,
        }),
      ),
  );

  server.registerTool(
    'get_document',
    {
      description:
        "Source complète, nom, type, revision et diagnostics d'un document (pass, fichier, @vertex ou @config).",
      inputSchema: {
        shaderId: z
          .string()
          .optional()
          .describe('Optionnel : doit correspondre au shader sélectionné'),
        documentId: z.string().describe('Id du document (pass, fichier, "@vertex" ou "@config")'),
      },
      outputSchema: DocumentSnapshotSchema.shape,
      annotations: readOnly,
    },
    async ({ shaderId, documentId }) =>
      handle(
        () => controller.getDocument(documentId, shaderId),
        (doc) => ({
          content: [
            text(
              `"${doc.name}" (${doc.kind}) — revision ${doc.revision}, ${doc.diagnostics.length} diagnostic(s).`,
            ),
            ...(shaderId
              ? [resourceLink(documentUri(shaderId, doc.id), `${doc.name} source`, 'text/plain')]
              : []),
          ],
          structuredContent: doc,
        }),
      ),
  );

  server.registerTool(
    'apply_shader_patch',
    {
      description:
        'Applique un lot de remplacements de texte à un ou plusieurs documents, atomiquement. ' +
        '`baseRevision` doit être la revision vue au dernier `get_project`/`get_document` — ' +
        "sinon la requête est rejetée (STALE_REVISION) plutôt que d'écraser une édition plus récente. " +
        'Compile le résultat et retourne la nouvelle revision et les diagnostics. Ne sauvegarde jamais.',
      inputSchema: {
        shaderId: z.string().describe('Identifiant du shader'),
        baseRevision: z.number().int().describe('Revision vue au dernier get_project/get_document'),
        edits: z
          .array(
            z.object({
              documentId: z.string(),
              start: z.number().int().min(0),
              end: z.number().int().min(0),
              text: z.string(),
            }),
          )
          .min(1)
          .describe('Édits {documentId, start, end, text}, appliqués tous ensemble ou aucun'),
      },
      outputSchema: PatchResultSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ shaderId, baseRevision, edits }) =>
      handle(
        () => controller.applyPatch(shaderId, baseRevision, edits),
        (result) => ({
          content: [
            text(
              `Patch appliqué — revision ${result.revision}, ${result.diagnostics.length} diagnostic(s)` +
                `${result.diagnostics.some((d) => d.severity === 'error') ? ', erreurs' : ''}.`,
            ),
            resourceLink(diagnosticsUri(shaderId), 'diagnostics', 'application/json'),
          ],
          structuredContent: result,
        }),
      ),
  );

  server.registerTool(
    'set_params',
    {
      description:
        'Règle plusieurs uniforms live en une seule requête. Chaque valeur est validée contre le ' +
        'schéma de contrôles ; les clés invalides sont rapportées sans bloquer les autres.',
      inputSchema: {
        shaderId: z
          .string()
          .optional()
          .describe('Optionnel : doit correspondre au shader sélectionné'),
        params: z
          .record(z.string(), COMMAND_SCHEMAS.setParam.payload.shape.value)
          .describe('Clé de contrôle -> valeur'),
      },
      outputSchema: SetParamsResultSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ shaderId, params }) =>
      handle(
        () => controller.setParams(params, shaderId),
        (result) => ({
          content: [
            text(
              `${result.applied.length} paramètre(s) appliqué(s)` +
                `${Object.keys(result.errors).length ? `, ${Object.keys(result.errors).length} erreur(s)` : ''}.`,
            ),
          ],
          structuredContent: result,
        }),
      ),
  );

  server.registerTool(
    'compile_project',
    {
      description:
        'Force une compilation immédiate (comme Ctrl+Entrée) et attend le résultat réel du compilateur ' +
        '— pas un délai fixe. Retourne la revision compilée et ses diagnostics.',
      inputSchema: {
        shaderId: z
          .string()
          .optional()
          .describe('Optionnel : doit correspondre au shader sélectionné'),
      },
      outputSchema: CompileResultSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ shaderId }) =>
      handle(
        () => controller.compileProject(shaderId),
        (result) => ({
          content: [
            text(
              `Revision ${result.revision} compilée — ${result.diagnostics.length} diagnostic(s)` +
                `${result.hasErrors ? ', erreurs' : ''}.`,
            ),
          ],
          structuredContent: result,
        }),
      ),
  );

  server.registerTool(
    'render_frame',
    {
      description:
        'Rend une frame PNG déterministe hors-écran (temps, taille et paramètres optionnels) sans ' +
        'modifier la session live en cours — le clock et les params live sont restaurés après capture.',
      inputSchema: {
        shaderId: z
          .string()
          .optional()
          .describe('Optionnel : doit correspondre au shader sélectionné'),
        time: z
          .number()
          .min(0)
          .optional()
          .describe('iTime de la frame. 0 par défaut (déterministe).'),
        width: z.number().int().min(1).max(4096).optional().describe('Largeur en pixels'),
        height: z.number().int().min(1).max(4096).optional().describe('Hauteur en pixels'),
        params: z
          .record(z.string(), COMMAND_SCHEMAS.setParam.payload.shape.value)
          .optional()
          .describe('Overrides temporaires, restaurés après la capture'),
      },
      outputSchema: RenderFrameResultSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ shaderId, time, width, height, params }) =>
      handle(
        () => controller.renderFrame({ shaderId, time, width, height, params }),
        (frame) => ({
          content: [
            { type: 'image', data: frame.base64, mimeType: frame.mimeType },
            text(`${frame.width}x${frame.height} @ t=${frame.time}`),
          ],
          structuredContent: frame,
        }),
      ),
  );

  // ---------------------------------------------------------------------------
  // Resources
  // ---------------------------------------------------------------------------

  server.registerResource(
    'library',
    libraryUri(),
    {
      title: 'Shader library',
      description: 'Every shader in the workspace (summary only).',
      mimeType: 'application/json',
    },
    async (uri) => {
      const shaders = await controller.listShaders();
      return {
        contents: [
          { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(shaders, null, 2) },
        ],
      };
    },
  );

  server.registerResource(
    'project',
    new ResourceTemplate('shader-studio://shaders/{shaderId}/project', { list: undefined }),
    { title: 'Shader project', mimeType: 'application/json' },
    async (uri, variables) => {
      const project = await controller.getProject(String(variables['shaderId']));
      return {
        contents: [
          { uri: uri.href, mimeType: 'application/json', text: JSON.stringify(project, null, 2) },
        ],
      };
    },
  );

  server.registerResource(
    'document',
    new ResourceTemplate('shader-studio://shaders/{shaderId}/documents/{documentId}', {
      list: undefined,
    }),
    { title: 'Document source' },
    async (uri, variables) => {
      const doc = await controller.getDocument(
        String(variables['documentId']),
        String(variables['shaderId']),
      );
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: doc.kind === 'config' ? 'application/json' : 'text/plain',
            text: doc.source,
          },
        ],
      };
    },
  );

  server.registerResource(
    'diagnostics',
    new ResourceTemplate('shader-studio://shaders/{shaderId}/diagnostics', { list: undefined }),
    { title: 'Compile diagnostics', mimeType: 'application/json' },
    async (uri, variables) => {
      const project = await controller.getProject(String(variables['shaderId']));
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(project.diagnostics, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    'preview',
    new ResourceTemplate('shader-studio://shaders/{shaderId}/preview.png', { list: undefined }),
    { title: 'Live preview', mimeType: 'image/png' },
    async (uri, variables) => {
      const shaderId = String(variables['shaderId']);
      const state = await controller.getState();
      if (state.selectedId !== shaderId) {
        throw new Error(`"${shaderId}" is not the currently selected shader.`);
      }
      const frame = await controller.screenshot();
      return { contents: [{ uri: uri.href, mimeType: frame.mimeType, blob: frame.base64 }] };
    },
  );

  return server;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  for (const warning of config.warnings) logger.warn(warning);

  const wss = await startBridge(config.port, config.host, logger);
  installBridgeShutdown(wss, logger);

  const server = buildServer(new BridgeController());

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('MCP server ready');
}

// Only run the server when this file is the entrypoint — not when a test
// imports `buildServer` to wire it to an in-memory transport instead.
const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  main().catch((error: unknown) => {
    const message =
      error instanceof ConfigError
        ? `Invalid configuration: ${error.message}`
        : `Failed to start: ${error instanceof Error ? error.message : String(error)}`;
    process.stderr.write(`[shader-studio-mcp] ${message}\n`);
    process.exit(1);
  });
}

// Re-exported so tests can validate the same error shape the tools return.
export { McpErrorSchema, McpDiagnosticSchema };
