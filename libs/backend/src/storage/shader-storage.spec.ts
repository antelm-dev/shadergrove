import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LEGACY_BUNDLE_FORMAT,
  getBloomEffect,
  type ShaderPayload,
} from '@shadergrove/shared/model';
import {
  addBuffer,
  addFile,
  bufferPasses,
  imagePass,
  setChannelBinding,
} from '@shadergrove/shared/project';
import { buildCollectionBundle, parseBundle } from '@shadergrove/shared/validate';
import { ShaderStorage, StorageError, DEFAULT_VERTEX, TEMPLATE_FRAGMENT } from './index';

let root: string;
let storage: ShaderStorage;

const FRAGMENT = 'void main() { gl_FragColor = vec4(1.0); }';

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'shader-studio-test-'));
  storage = new ShaderStorage({
    dataDir: path.join(root, 'data'),
    examplesDir: path.join(root, 'examples'),
  });
  await storage.init();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seed(name = 'Demo'): Promise<string> {
  const created = await storage.create({ name });
  return created.id;
}

describe('create', () => {
  it('writes the four files that make up a shader', async () => {
    const shader = await storage.create({ name: 'Hex Pulse' });
    const dir = path.join(root, 'data', 'shaders', 'hex-pulse');

    expect(shader.id).toBe('hex-pulse');
    await expect(readFile(path.join(dir, 'meta.json'), 'utf8')).resolves.toContain('Hex Pulse');
    await expect(readFile(path.join(dir, 'fragment.glsl'), 'utf8')).resolves.toBe(
      TEMPLATE_FRAGMENT,
    );
    await expect(readFile(path.join(dir, 'vertex.glsl'), 'utf8')).resolves.toBe(DEFAULT_VERTEX);
    await expect(readFile(path.join(dir, 'presets.json'), 'utf8')).resolves.toContain('presets');
  });

  it('does not persist the id inside meta.json — the directory name is the id', async () => {
    await storage.create({ name: 'Demo' });
    const meta = JSON.parse(
      await readFile(path.join(root, 'data', 'shaders', 'demo', 'meta.json'), 'utf8'),
    );
    expect(meta).not.toHaveProperty('id');
  });

  it('suffixes an id that is already taken', async () => {
    const first = await storage.create({ name: 'Waves' });
    const second = await storage.create({ name: 'Waves' });

    expect(first.id).toBe('waves');
    expect(second.id).toBe('waves-2');
  });

  it('rejects an empty name', async () => {
    await expect(storage.create({ name: '  ' })).rejects.toBeInstanceOf(StorageError);
  });

  it('rejects an invalid control schema and writes nothing', async () => {
    await expect(
      storage.create({ name: 'Bad', controls: [{ key: 'x', type: 'color', default: 'red' }] }),
    ).rejects.toMatchObject({ code: 'invalid' });

    expect(await storage.listIds()).toEqual([]);
  });
});

describe('path traversal', () => {
  it.each(['..', '../..', '../../etc', 'a/b', 'a\\b', '.', 'foo/../../bar', '%2e%2e'])(
    'refuses to read "%s"',
    async (id) => {
      await expect(storage.read(id)).rejects.toMatchObject({ code: 'invalid' });
    },
  );

  it('refuses to delete outside the shaders root', async () => {
    const victim = path.join(root, 'data', 'victim.txt');
    await writeFile(victim, 'do not delete me');

    await expect(storage.remove('../victim.txt')).rejects.toMatchObject({ code: 'invalid' });
    await expect(readFile(victim, 'utf8')).resolves.toBe('do not delete me');
  });

  it('refuses to write outside the shaders root', async () => {
    await expect(storage.update('../escape', { name: 'Nope' })).rejects.toMatchObject({
      code: 'invalid',
    });
  });

  it('refuses a traversing preset id', async () => {
    const id = await seed();
    await expect(storage.deletePreset(id, '../../etc')).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('read', () => {
  it('404s on a shader that does not exist', async () => {
    await expect(storage.read('nope')).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });

  it('skips a corrupt shader in the listing rather than failing the whole list', async () => {
    await storage.create({ name: 'Good' });

    const broken = path.join(root, 'data', 'shaders', 'broken');
    await mkdir(broken, { recursive: true });
    await writeFile(path.join(broken, 'meta.json'), '{ not json');

    const list = await storage.list();
    expect(list.map((entry) => entry.id)).toEqual(['good']);
  });
});

describe('update', () => {
  it('only touches the fields it is given', async () => {
    const id = await seed();
    const before = await storage.read(id);

    const after = await storage.update(id, { fragment: FRAGMENT });

    expect(after.fragment).toBe(FRAGMENT);
    expect(after.name).toBe(before.name);
    expect(after.vertex).toBe(before.vertex);
    expect(after.controls).toEqual(before.controls);
  });

  it('renames without moving the shader on disk', async () => {
    const id = await seed('Original');
    const renamed = await storage.update(id, { name: 'Renamed' });

    expect(renamed.id).toBe(id);
    expect(renamed.name).toBe('Renamed');
    expect(await storage.listIds()).toEqual([id]);
  });

  it('re-projects presets when the schema changes', async () => {
    const id = await storage
      .create({
        name: 'Demo',
        controls: [
          { key: 'speed', type: 'number', default: 1, min: 0, max: 2 },
          { key: 'gone', type: 'number', default: 5, min: 0, max: 10 },
        ],
      })
      .then((shader) => shader.id);

    await storage.savePreset(id, { name: 'Fast', values: { speed: 2, gone: 9 } });

    const updated = await storage.update(id, {
      controls: [{ key: 'speed', type: 'number', default: 0.5, min: 0, max: 1 }],
    });

    expect(updated.presets[0].values).toEqual({ speed: 1 });
  });

  it('rejects an invalid patch without corrupting what is on disk', async () => {
    const id = await seed();
    const before = await storage.read(id);

    await expect(storage.update(id, { fragment: '' })).rejects.toMatchObject({ code: 'invalid' });

    expect((await storage.read(id)).fragment).toBe(before.fragment);
  });
});

describe('duplicate', () => {
  it('copies the source, its schema and its presets under a new id', async () => {
    const id = await seed('Original');
    await storage.update(id, { fragment: FRAGMENT });
    await storage.savePreset(id, { name: 'Warm', values: {} });

    const copy = await storage.duplicate(id, 'Copy');

    expect(copy.id).toBe('copy');
    expect(copy.name).toBe('Copy');
    expect(copy.fragment).toBe(FRAGMENT);
    expect(copy.presets.map((preset) => preset.name)).toEqual(['Warm']);

    expect((await storage.read(id)).name).toBe('Original');
  });

  it('defaults to "<name> copy"', async () => {
    const id = await seed('Original');
    const copy = await storage.duplicate(id);
    expect(copy.name).toBe('Original copy');
  });

  it('carries the project — buffers, files and channel wiring — into the copy', async () => {
    const id = await seed('Original');
    const withBuffer = addBuffer((await storage.read(id)).project);
    const withFile = addFile(withBuffer, 'lib.glsl');
    await storage.update(id, { project: withFile });

    const copy = await storage.duplicate(id, 'Copy');

    expect(bufferPasses(copy.project)).toHaveLength(1);
    expect(bufferPasses(copy.project)[0].id).toBe(bufferPasses(withFile)[0].id);
    expect(copy.project.files.map((file) => file.name)).toEqual(['lib.glsl']);
  });
});

describe('project', () => {
  it('writes project.json, and a fresh read (or a fresh ShaderStorage) sees the identical buffers, Common, files and wiring', async () => {
    const id = await seed('Multi Pass');
    const base = (await storage.read(id)).project;
    const withBuffer = addBuffer(base);
    const buffer = bufferPasses(withBuffer)[0];
    const withFile = addFile(withBuffer, 'lib.glsl');
    const wired = setChannelBinding(withFile, imagePass(withFile).id, 0, {
      kind: 'buffer',
      passId: buffer.id,
      feedback: true,
    });

    await storage.update(id, { project: wired });

    await expect(
      readFile(path.join(root, 'data', 'shaders', id, 'project.json'), 'utf8'),
    ).resolves.toContain('"kind": "buffer"');

    expect((await storage.read(id)).project).toEqual(wired);

    const fresh = new ShaderStorage({
      dataDir: path.join(root, 'data'),
      examplesDir: path.join(root, 'examples'),
      seed: false,
    });
    expect((await fresh.read(id)).project).toEqual(wired);
  });

  it('a shader with no project.json reads as a single-pass, legacy-migrated project', async () => {
    const id = await seed('Legacy');
    await rm(path.join(root, 'data', 'shaders', id, 'project.json'), { force: true });

    const record = await storage.read(id);
    expect(record.project.passes).toHaveLength(2);
    expect(imagePass(record.project).source).toBe(record.fragment);
    expect(imagePass(record.project).channels).toEqual([
      { kind: 'texture', slot: 0 },
      { kind: 'texture', slot: 1 },
      { kind: 'texture', slot: 2 },
      { kind: 'texture', slot: 3 },
    ]);
  });

  it('a corrupt project.json degrades to the legacy-migrated project rather than 404ing the shader', async () => {
    const id = await seed('Corrupt');
    await writeFile(path.join(root, 'data', 'shaders', id, 'project.json'), '{ not json');

    const record = await storage.read(id);
    expect(imagePass(record.project).source).toBe(record.fragment);
  });

  it('a legacy `fragment`/`vertex` patch reconciles onto the current project instead of replacing it', async () => {
    const id = await seed('Legacy Patch');
    await storage.update(id, { project: addBuffer((await storage.read(id)).project) });

    const updated = await storage.update(id, { fragment: FRAGMENT });

    expect(imagePass(updated.project).source).toBe(FRAGMENT);
    expect(bufferPasses(updated.project)).toHaveLength(1);
  });
});

describe('thumbnail', () => {
  const WEBP = Buffer.from('a fake webp');
  const PNG = Buffer.from('a fake png');

  it('stores the preview and points the meta at it', async () => {
    const id = await seed();

    const saved = await storage.setThumbnail(id, { ext: 'webp', bytes: WEBP });

    expect(saved.thumbnail?.ext).toBe('webp');
    const read = await storage.readThumbnail(id);
    expect(read?.bytes).toEqual(WEBP);
    expect((await storage.read(id)).thumbnail?.updatedAt).toBe(saved.thumbnail?.updatedAt);
  });

  it('has none until one is captured', async () => {
    const id = await seed();
    expect((await storage.read(id)).thumbnail).toBeNull();
    expect(await storage.readThumbnail(id)).toBeNull();
  });

  it('leaves the shader itself untouched — a preview is not an edit', async () => {
    const id = await seed();
    const before = await storage.read(id);

    const after = await storage.setThumbnail(id, { ext: 'webp', bytes: WEBP });

    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.fragment).toBe(before.fragment);
  });

  it('replaces a preview stored under a different extension', async () => {
    const id = await seed();
    await storage.setThumbnail(id, { ext: 'webp', bytes: WEBP });

    await storage.setThumbnail(id, { ext: 'png', bytes: PNG });

    const dir = path.join(root, 'data', 'shaders', id);
    await expect(readFile(path.join(dir, 'thumbnail.webp'))).rejects.toThrow();
    expect((await storage.readThumbnail(id))?.ext).toBe('png');
  });

  it('rejects an unsupported image type', async () => {
    const id = await seed();
    await expect(storage.setThumbnail(id, { ext: 'gif', bytes: WEBP })).rejects.toMatchObject({
      code: 'invalid',
    });
  });

  it('degrades to no preview when the meta points at a file that is gone', async () => {
    const id = await seed();
    await storage.setThumbnail(id, { ext: 'webp', bytes: WEBP });

    await rm(path.join(root, 'data', 'shaders', id, 'thumbnail.webp'));

    expect(await storage.readThumbnail(id)).toBeNull();
    expect((await storage.exportOne(id)).thumbnail).toBeNull();
  });

  it('follows a duplicate', async () => {
    const id = await seed('Original');
    await storage.setThumbnail(id, { ext: 'webp', bytes: WEBP });

    const copy = await storage.duplicate(id, 'Copy');

    expect(copy.thumbnail?.ext).toBe('webp');
    expect((await storage.readThumbnail(copy.id))?.bytes).toEqual(WEBP);
  });

  it('survives an export/import round trip', async () => {
    const id = await seed('Original');
    await storage.setThumbnail(id, { ext: 'webp', bytes: WEBP });

    const bundle = buildCollectionBundle([await storage.exportOne(id)]);
    const parsed = parseBundle(JSON.parse(JSON.stringify(bundle)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    await storage.remove(id);
    await storage.importPayloads(parsed.value, 'rename');

    expect((await storage.readThumbnail(id))?.bytes).toEqual(WEBP);
  });
});

describe('remove', () => {
  it('deletes the shader directory', async () => {
    const id = await seed();
    await storage.remove(id);

    expect(await storage.listIds()).toEqual([]);
    await expect(storage.read(id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('404s on a shader that does not exist', async () => {
    await expect(storage.remove('ghost')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('presets', () => {
  it('sanitizes the values it is given against the schema', async () => {
    const id = await storage
      .create({
        name: 'Demo',
        controls: [{ key: 'speed', type: 'number', default: 1, min: 0, max: 2 }],
      })
      .then((shader) => shader.id);

    const preset = await storage.savePreset(id, {
      name: 'Wild',
      values: { speed: 999, bogus: 'nonsense' },
    });

    expect(preset.values).toEqual({ speed: 2 });
  });

  it('overwrites a preset of the same name instead of duplicating it', async () => {
    const id = await seed();

    const first = await storage.savePreset(id, { name: 'Look', values: { scale: 4 } });
    const second = await storage.savePreset(id, { name: 'Look', values: { scale: 8 } });

    expect(second.id).toBe(first.id);

    const shader = await storage.read(id);
    expect(shader.presets).toHaveLength(1);
    expect(shader.presets[0].values['scale']).toBe(8);
  });

  it('keeps distinct names as distinct presets', async () => {
    const id = await seed();
    await storage.savePreset(id, { name: 'One', values: {} });
    await storage.savePreset(id, { name: 'Two', values: {} });

    const shader = await storage.read(id);
    expect(shader.presets.map((preset) => preset.id)).toEqual(['one', 'two']);
  });

  it('rejects an empty preset name', async () => {
    const id = await seed();
    await expect(storage.savePreset(id, { name: '', values: {} })).rejects.toMatchObject({
      code: 'invalid',
    });
  });

  it('captures the render settings when it is given some, and clamps them', async () => {
    const id = await seed();

    const preset = await storage.savePreset(id, {
      name: 'Glow',
      values: {},
      render: { bloom: { enabled: true, strength: 99, radius: 0.4, threshold: 0.7 } },
    });

    expect(preset.render).toEqual({
      postProcessing: {
        enabled: true,
        effects: [
          {
            type: 'bloom',
            instanceId: 'bloom',
            enabled: true,
            settings: { strength: 3, radius: 0.4, threshold: 0.7 },
          },
        ],
      },
    });
    const stored = (await storage.read(id)).presets[0].render;
    expect(stored && getBloomEffect(stored).enabled).toBe(true);
  });

  it('leaves render off a preset saved without it, rather than storing the defaults', async () => {
    const id = await seed();
    await storage.savePreset(id, { name: 'Values only', values: {} });

    // A values-only preset must not carry bloom at all: applying it would
    // otherwise reset the shader's own render settings to the defaults.
    expect((await storage.read(id)).presets[0].render).toBeUndefined();
  });

  it('deletes a preset', async () => {
    const id = await seed();
    const preset = await storage.savePreset(id, { name: 'Look', values: {} });

    await storage.deletePreset(id, preset.id);
    expect((await storage.read(id)).presets).toEqual([]);
  });

  it('404s when deleting a preset that is not there', async () => {
    const id = await seed();
    await expect(storage.deletePreset(id, 'ghost')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('import / export', () => {
  async function exportedPayloads(): Promise<ShaderPayload[]> {
    const bundle = buildCollectionBundle(await storage.exportAll());
    const parsed = parseBundle(bundle);
    if (!parsed.ok) throw new Error(parsed.errors.join('; '));
    return parsed.value;
  }

  it('round-trips a collection through export -> parse -> import', async () => {
    const id = await seed('Round Trip');
    await storage.update(id, { fragment: FRAGMENT });
    await storage.savePreset(id, { name: 'Warm', values: {} });

    const payloads = await exportedPayloads();

    const fresh = new ShaderStorage({
      dataDir: path.join(root, 'data2'),
      examplesDir: path.join(root, 'examples'),
    });
    await fresh.init();
    await fresh.importPayloads(payloads, 'rename');

    const imported = await fresh.read(id);
    expect(imported.name).toBe('Round Trip');
    expect(imported.fragment).toBe(FRAGMENT);
    expect(imported.presets.map((preset) => preset.name)).toEqual(['Warm']);
    expect(imported.controls).toEqual((await storage.read(id)).controls);
  });

  it('rename mode never destroys an existing shader', async () => {
    const id = await seed('Keep Me');
    await storage.update(id, { fragment: FRAGMENT });

    const payloads = await exportedPayloads();
    const result = await storage.importPayloads(payloads, 'rename');

    expect(result.imported[0].id).toBe('keep-me-2');
    expect(result.imported[0].replaced).toBe(false);

    expect((await storage.read('keep-me')).fragment).toBe(FRAGMENT);
    expect(await storage.listIds()).toEqual(['keep-me', 'keep-me-2']);
  });

  it('overwrite mode replaces the shader that holds the id', async () => {
    const id = await seed('Target');
    const payloads = await exportedPayloads();

    await storage.update(id, { fragment: 'void main() { gl_FragColor = vec4(0.0); }' });

    const result = await storage.importPayloads(payloads, 'overwrite');

    expect(result.imported[0]).toMatchObject({ id: 'target', replaced: true });
    expect((await storage.read('target')).fragment).toBe(TEMPLATE_FRAGMENT);
    expect(await storage.listIds()).toEqual(['target']);
  });

  it('overwrite mode drops presets that the incoming shader does not have', async () => {
    const id = await seed('Target');
    const payloads = await exportedPayloads();

    await storage.savePreset(id, { name: 'Added Later', values: {} });
    await storage.importPayloads(payloads, 'overwrite');

    expect((await storage.read('target')).presets).toEqual([]);
  });

  it('gives two colliding shaders in one bundle distinct ids', async () => {
    await seed('Clash');

    const [payload] = await exportedPayloads();
    const result = await storage.importPayloads([payload, { ...payload }], 'rename');

    expect(result.imported.map((entry) => entry.id)).toEqual(['clash-2', 'clash-3']);
    expect(await storage.listIds()).toEqual(['clash', 'clash-2', 'clash-3']);
  });

  it("round-trips a project's buffers, Common, files and channel wiring through export -> import", async () => {
    const id = await seed('Round Trip Project');
    const withBuffer = addBuffer((await storage.read(id)).project);
    const buffer = bufferPasses(withBuffer)[0];
    const withFile = addFile(withBuffer, 'lib.glsl');
    const wired = setChannelBinding(withFile, imagePass(withFile).id, 1, {
      kind: 'buffer',
      passId: buffer.id,
      feedback: true,
    });
    await storage.update(id, { project: wired });

    const payloads = await exportedPayloads();

    const fresh = new ShaderStorage({
      dataDir: path.join(root, 'data3'),
      examplesDir: path.join(root, 'examples'),
    });
    await fresh.init();
    await fresh.importPayloads(payloads, 'rename');

    expect((await fresh.read(id)).project).toEqual(wired);
  });

  it('imports a shader-studio/v1 bundle with no `project` field, synthesizing one via migrateLegacyProject', async () => {
    const id = await seed('Legacy Bundle');
    await storage.update(id, { fragment: FRAGMENT });

    const [full] = await exportedPayloads();
    const v1Payload: Partial<ShaderPayload> = { ...full };
    delete v1Payload.project;

    const bundle = {
      format: LEGACY_BUNDLE_FORMAT,
      kind: 'shader',
      exportedAt: new Date().toISOString(),
      shader: v1Payload,
    };
    const parsed = parseBundle(bundle);
    if (!parsed.ok) throw new Error(parsed.errors.join('; '));

    const fresh = new ShaderStorage({
      dataDir: path.join(root, 'data4'),
      examplesDir: path.join(root, 'examples'),
    });
    await fresh.init();
    await fresh.importPayloads(parsed.value, 'rename');

    const imported = await fresh.read(id);
    expect(imported.fragment).toBe(FRAGMENT);
    expect(imagePass(imported.project).source).toBe(FRAGMENT);
  });
});

describe('seeding', () => {
  it('starts empty and copies examples only when explicitly requested', async () => {
    const examples = path.join(root, 'seed-examples', 'shaders', 'demo');
    await mkdir(examples, { recursive: true });
    await writeFile(
      path.join(examples, 'meta.json'),
      JSON.stringify({ name: 'Seeded', controls: [] }),
    );
    await writeFile(path.join(examples, 'fragment.glsl'), FRAGMENT);
    await writeFile(path.join(examples, 'vertex.glsl'), DEFAULT_VERTEX);

    const empty = new ShaderStorage({
      dataDir: path.join(root, 'empty-data'),
      examplesDir: path.join(root, 'seed-examples'),
    });
    await empty.init();
    expect(await empty.listIds()).toEqual([]);

    const seeded = new ShaderStorage({
      dataDir: path.join(root, 'seed-data'),
      examplesDir: path.join(root, 'seed-examples'),
      seed: true,
    });
    await seeded.init();

    expect((await seeded.read('demo')).name).toBe('Seeded');
  });

  it('does not bring the examples back after they have been deleted', async () => {
    const examples = path.join(root, 'seed-examples', 'shaders', 'demo');
    await mkdir(examples, { recursive: true });
    await writeFile(
      path.join(examples, 'meta.json'),
      JSON.stringify({ name: 'Seeded', controls: [] }),
    );
    await writeFile(path.join(examples, 'fragment.glsl'), FRAGMENT);
    await writeFile(path.join(examples, 'vertex.glsl'), DEFAULT_VERTEX);

    const options = {
      dataDir: path.join(root, 'seed-data'),
      examplesDir: path.join(root, 'seed-examples'),
      seed: true,
    };

    const first = new ShaderStorage(options);
    await first.init();
    await first.remove('demo');

    const second = new ShaderStorage(options);
    await second.init();

    expect(await second.listIds()).toEqual([]);
  });
});
