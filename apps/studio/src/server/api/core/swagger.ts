/**
 * OpenAPI description of the shader API. The Nest app is mounted under `/api`,
 * so the UI lands on `/api/docs` and the raw document on `/api/docs-json`.
 *
 * Request bodies are described loosely on purpose: the authoritative shape
 * lives in `@shadergrove/shared` and is enforced by `validate*` at the
 * storage boundary. Transcribing those types into DTO classes here would give
 * two definitions to keep in sync, and the second one would rot.
 */

import { applyDecorators, type INestApplication } from '@nestjs/common';
import { ApiResponse, DocumentBuilder, SwaggerModule, type ApiBodyOptions } from '@nestjs/swagger';

// `SchemaObject` itself is not re-exported from the package root, and its deep
// path is blocked by the exports map — so take it off a decorator that is.
type SchemaObject = Extract<ApiBodyOptions, { schema: unknown }>['schema'];

/** The envelope every failing request returns — see `ApiExceptionFilter`. */
export const ERROR_SCHEMA: SchemaObject = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string', example: 'not_found' },
        message: { type: 'string' },
        details: { type: 'array', items: { type: 'string' } },
      },
    },
  },
};

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: 'The request body or a parameter was rejected (`invalid`).',
  403: 'The caller is signed in but not allowed to do this (`forbidden`).',
  404: 'No such shader, preset, texture or publication (`not_found`).',
  409: 'A concurrent write happened — `expectedRevision` is stale (`conflict`).',
  429: 'Too many requests from this account (`rate_limited`).',
  500: 'Unexpected server or storage failure (`internal`, `io`).',
  503: 'API initialization or database readiness failed (`internal`).',
};

/** Documents the shared error envelope for the statuses a route can actually return. */
export function ApiErrors(...statuses: number[]): MethodDecorator {
  return applyDecorators(
    ...statuses.map((status) =>
      ApiResponse({
        status,
        description: ERROR_DESCRIPTIONS[status] ?? 'Error',
        schema: ERROR_SCHEMA,
      }),
    ),
  );
}

/** A shader's writable fields. Nested shapes stay free-form (see file header). */
export const SHADER_BODY_SCHEMA: SchemaObject = {
  type: 'object',
  properties: {
    name: { type: 'string', example: 'Plasma' },
    description: { type: 'string' },
    fragment: { type: 'string', description: 'GLSL source of the Image pass.' },
    vertex: { type: 'string', description: 'GLSL vertex source.' },
    controls: { type: 'array', items: { type: 'object' }, description: 'Uniform controls.' },
    render: { type: 'object', description: 'Render settings, incl. the post-processing chain.' },
    project: { type: 'object', description: 'Multi-pass document: buffers, Common, files.' },
    channels: { type: 'object', description: 'Texture channel wiring (update only).' },
    expectedRevision: {
      type: 'integer',
      description: 'Revision the client last read. A mismatch is answered with 409.',
    },
  },
};

/** Raw `image/*` upload used by the texture and thumbnail routes. */
export const IMAGE_BODY_SCHEMA: SchemaObject = { type: 'string', format: 'binary' };

export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Shadergrove API')
    .setDescription(
      'REST API backing the Shadergrove editor: shaders, presets, textures, ' +
        'bundle import/export and UI translations.',
    )
    .setVersion('1.0')
    .addTag('shaders', 'Create, read, update and delete shaders')
    .addTag('presets', 'Saved control values for a shader')
    .addTag('history', 'Saved document states of a shader: list, name and restore')
    .addTag('textures', 'Channel images and thumbnails')
    .addTag('transfer', 'Bundle import and export, including Shadertoy')
    .addTag('i18n', 'UI translation catalogs')
    .addTag('explore', 'Public shader snapshots: browse, publish, copy and report')
    .addTag('moderation', 'Administration of publications, reports and publishers')
    .build();

  SwaggerModule.setup('docs', app, () => SwaggerModule.createDocument(app, config), {
    jsonDocumentUrl: 'docs-json',
    customSiteTitle: 'Shadergrove API',
  });
}
