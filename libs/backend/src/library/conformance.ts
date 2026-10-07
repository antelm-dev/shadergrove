/**
 * A single behavioural suite every storage engine must pass. Both the SQLite and
 * the Postgres spec import `runShaderLibraryConformance` and hand it a harness
 * that provisions an empty store of their kind; the assertions below then run
 * against a real `ShaderLibrary` on top of it. This is where the guarantee that
 * "the logic is not duplicated between engines" is actually enforced — one suite,
 * two backends.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_CHANNELS,
  DEFAULT_RENDER,
  LEGACY_BUNDLE_FORMAT,
  getBloomEffect,
  type ShaderPayload,
  type TextureChannelPayloads,
} from '@shadergrove/shared/model';
import {
  addBuffer,
  addFile,
  bufferPasses,
  imagePass,
  migrateLegacyProject,
  setChannelBinding,
  setPassSource,
} from '@shadergrove/shared/project';
import { buildCollectionBundle, parseBundle } from '@shadergrove/shared/validate';
import { DEFAULT_VERTEX, TEMPLATE_FRAGMENT } from '@shadergrove/shared/templates';

import { ShaderLibrary, type PayloadSource } from './shader-library';
import { StorageError } from './storage-error';
import type { AssetKey, ShaderRepository, ShaderTx } from '../persistence/shader-repository';
import { LOCAL_SCOPE, LOCAL_USER_ID } from '../persistence/user-scope';

export interface ConformanceHarness {
  /** A repository over this harness's (empty) store. Calling again re-opens the same store. */
  makeRepository(): ShaderRepository;
  /** Drops the store and releases resources. */
  cleanup(): Promise<void>;
  /** Overwrites a shader's `project_json` with invalid JSON, for corruption tests. */
  corruptProjectJson(id: string): Promise<void>;
  /** Deletes an asset row directly, leaving `channels_json` pointing at bytes that are gone. */
  removeAssetRow(id: string, key: AssetKey): Promise<void>;
  /** Deletes every history row of a shader, leaving it as a pre-feature library would. */
  clearHistory(id: string): Promise<void>;
  countHistory(id: string): Promise<number>;
  /** Makes one entry's stored controls unreadable, for refusal tests. */
  corruptHistory(id: string, revision: number): Promise<void>;
}

const PNG = Buffer.from('a fake png image').toString('base64');
const WEBP = Buffer.from('a fake webp preview').toString('base64');
const FRAGMENT = 'void main() { gl_FragColor = vec4(1.0); }';

function payloadOf(id: string, name: string, extra: Partial<ShaderPayload> = {}): ShaderPayload {
  return {
    id,
    name,
    description: '',
    controls: [],
    render: { ...DEFAULT_RENDER },
    fragment: TEMPLATE_FRAGMENT,
    vertex: DEFAULT_VERTEX,
    presets: [],
    channels: DEFAULT_CHANNELS.map((channel) => ({
      ...channel,
      data: null,
    })) as unknown as TextureChannelPayloads,
    thumbnail: null,
    project: migrateLegacyProject(TEMPLATE_FRAGMENT, DEFAULT_VERTEX),
    ...extra,
  };
}

function withTexture(payload: ShaderPayload, channel: number, data = PNG): ShaderPayload {
  const channels = payload.channels.map((entry, index) =>
    index === channel ? { ...entry, ext: 'png', width: 2, height: 2, data } : entry,
  ) as unknown as TextureChannelPayloads;
  return { ...payload, channels };
}

export function runShaderLibraryConformance(
  engine: string,
  newHarness: () => ConformanceHarness,
): void {
  describe(`ShaderLibrary conformance (${engine})`, () => {
    let harness: ConformanceHarness;
    let lib: ShaderLibrary;

    beforeEach(async () => {
      harness = newHarness();
      lib = new ShaderLibrary(harness.makeRepository(), LOCAL_SCOPE);
      await lib.init();
    });

    afterEach(async () => {
      await lib.close().catch(() => undefined);
      await harness.cleanup();
    });

    // 1 — initialisation & migrations
    it('starts empty and re-initialises idempotently', async () => {
      expect(await lib.list()).toEqual([]);
      await lib.init();
      expect(await lib.list()).toEqual([]);
    });

    // 2 — create
    it('creates a shader from the template', async () => {
      const shader = await lib.create({ name: 'Hex Pulse' });
      expect(shader.id).toBe('hex-pulse');
      expect(shader.revision).toBe(1);
      expect(shader.fragment).toBe(TEMPLATE_FRAGMENT);
      expect(shader.vertex).toBe(DEFAULT_VERTEX);
    });

    it('suffixes an id that is already taken', async () => {
      await lib.create({ name: 'Waves' });
      const second = await lib.create({ name: 'Waves' });
      expect(second.id).toBe('waves-2');
    });

    it('rejects an empty name and an invalid control schema', async () => {
      await expect(lib.create({ name: '  ' })).rejects.toMatchObject({ code: 'invalid' });
      await expect(
        lib.create({ name: 'Bad', controls: [{ key: 'x', type: 'color', default: 'red' }] }),
      ).rejects.toMatchObject({ code: 'invalid' });
      expect(await lib.list()).toEqual([]);
    });

    // 3 — read
    it('404s on a missing shader and rejects a traversing id', async () => {
      await expect(lib.read('nope')).rejects.toMatchObject({ code: 'not_found' });
      for (const id of ['..', '../etc', 'a/b', 'a\\b', '%2e%2e']) {
        await expect(lib.read(id)).rejects.toMatchObject({ code: 'invalid' });
      }
    });

    // 4 — sorted list
    it('lists summaries sorted by name', async () => {
      await lib.create({ name: 'Banana' });
      await lib.create({ name: 'Apple' });
      await lib.create({ name: 'Cherry' });
      expect((await lib.list()).map((entry) => entry.name)).toEqual(['Apple', 'Banana', 'Cherry']);
    });

    // 5 — cascade delete (a successful delete of a shader that has presets + assets proves the FK cascade)
    it('deletes a shader together with its presets and assets', async () => {
      const { id } = await lib.create({ name: 'Doomed' });
      await lib.savePreset(id, { name: 'P', values: {} });
      await lib.setTexture(id, 0, { ext: 'png', bytes: Buffer.from('x'), width: 1, height: 1 });
      await lib.setThumbnail(id, { ext: 'png', bytes: Buffer.from('y') });

      await lib.remove(id);
      expect(await lib.list()).toEqual([]);
      await expect(lib.read(id)).rejects.toMatchObject({ code: 'not_found' });
      await expect(lib.remove(id)).rejects.toMatchObject({ code: 'not_found' });
    });

    // 6 — update
    it('updates only the given fields and bumps the revision', async () => {
      const created = await lib.create({ name: 'Demo' });
      const updated = await lib.update(created.id, { fragment: FRAGMENT });
      expect(updated.fragment).toBe(FRAGMENT);
      expect(updated.name).toBe('Demo');
      expect(updated.vertex).toBe(created.vertex);
      expect(updated.revision).toBe(created.revision + 1);
    });

    it('renames without changing the id and re-projects presets on a schema change', async () => {
      const created = await lib.create({
        name: 'Demo',
        controls: [
          { key: 'speed', type: 'number', default: 1, min: 0, max: 2 },
          { key: 'gone', type: 'number', default: 5, min: 0, max: 10 },
        ],
      });
      await lib.savePreset(created.id, { name: 'Fast', values: { speed: 2, gone: 9 } });
      const updated = await lib.update(created.id, {
        name: 'Renamed',
        controls: [{ key: 'speed', type: 'number', default: 0.5, min: 0, max: 1 }],
      });
      expect(updated.id).toBe(created.id);
      expect(updated.name).toBe('Renamed');
      expect(updated.presets[0].values).toEqual({ speed: 1 });
    });

    it('rejects an invalid patch without changing what is stored', async () => {
      const { id } = await lib.create({ name: 'Demo' });
      const before = await lib.read(id);
      await expect(lib.update(id, { fragment: '' })).rejects.toMatchObject({ code: 'invalid' });
      expect((await lib.read(id)).fragment).toBe(before.fragment);
    });

    // 7 — duplicate
    it('duplicates a shader with its schema, presets, project and assets', async () => {
      const created = await lib.create({ name: 'Original' });
      // Add structure first (project is the source of truth), then reconcile the
      // fragment onto it — a fragment-only patch keeps the buffers and files.
      await lib.update(created.id, { project: addFile(addBuffer(created.project), 'lib.glsl') });
      await lib.update(created.id, { fragment: FRAGMENT });
      await lib.savePreset(created.id, { name: 'Warm', values: {} });
      await lib.setTexture(created.id, 1, {
        ext: 'png',
        bytes: Buffer.from('tex'),
        width: 2,
        height: 2,
      });
      await lib.setThumbnail(created.id, { ext: 'webp', bytes: Buffer.from('thumb') });

      const copy = await lib.duplicate(created.id, 'Copy');
      expect(copy.id).toBe('copy');
      expect(copy.fragment).toBe(FRAGMENT);
      expect(copy.presets.map((preset) => preset.name)).toEqual(['Warm']);
      expect(bufferPasses(copy.project)).toHaveLength(1);
      expect(copy.project.files.map((file) => file.name)).toEqual(['lib.glsl']);
      expect((await lib.readTexture(copy.id, 1))?.bytes).toEqual(
        new Uint8Array(Buffer.from('tex')),
      );
      expect(copy.thumbnail?.ext).toBe('webp');
      expect((await lib.read(created.id)).name).toBe('Original');
    });

    it('defaults the copy name to "<name> copy"', async () => {
      const { id } = await lib.create({ name: 'Original' });
      expect((await lib.duplicate(id)).name).toBe('Original copy');
    });

    // 8 — presets
    it('sanitises, overwrites by name, and deletes presets', async () => {
      const created = await lib.create({
        name: 'Demo',
        controls: [{ key: 'speed', type: 'number', default: 1, min: 0, max: 2 }],
      });
      const id = created.id;
      const wild = await lib.savePreset(id, { name: 'Wild', values: { speed: 999, bogus: 'x' } });
      expect(wild.values).toEqual({ speed: 2 });

      const first = await lib.savePreset(id, { name: 'Look', values: {} });
      const second = await lib.savePreset(id, { name: 'Look', values: {} });
      expect(second.id).toBe(first.id);
      expect((await lib.read(id)).presets).toHaveLength(2);

      await lib.deletePreset(id, first.id);
      expect((await lib.read(id)).presets.map((preset) => preset.name)).toEqual(['Wild']);
      await expect(lib.deletePreset(id, 'ghost')).rejects.toMatchObject({ code: 'not_found' });
    });

    it('keeps render off a values-only preset and clamps a supplied one', async () => {
      const { id } = await lib.create({ name: 'Demo' });
      await lib.savePreset(id, { name: 'Values', values: {} });
      expect((await lib.read(id)).presets[0].render).toBeUndefined();

      const glow = await lib.savePreset(id, {
        name: 'Glow',
        values: {},
        render: { bloom: { enabled: true, strength: 99, radius: 0.4, threshold: 0.7 } },
      });
      expect(glow.render && getBloomEffect(glow.render).settings.strength).toBe(3);
    });

    it('round-trips two custom effect instances: ids, code, controls, values and order', async () => {
      const { id } = await lib.create({ name: 'Effects' });
      const custom = (instanceId: string, gain: number) => ({
        type: 'custom' as const,
        instanceId,
        enabled: true,
        definition: {
          apiVersion: 1,
          name: 'Gain',
          source: 'vec4 effect(vec4 color, vec2 uv) { return color * u_gain; }',
          controls: [{ key: 'gain', type: 'number' as const, default: 1, min: 0, max: 2 }],
        },
        values: { gain },
      });
      const render = {
        postProcessing: {
          enabled: true,
          effects: [
            custom('custom-b', 0.5),
            { ...DEFAULT_RENDER.postProcessing.effects[0]! },
            custom('custom-a', 1.5),
          ],
        },
      };

      await lib.update(id, { render });
      expect((await lib.read(id)).render).toEqual(render);
      const preset = await lib.savePreset(id, { name: 'Look', values: {}, render });
      expect(preset.render).toEqual(render);
      expect((await lib.read(id)).presets[0]?.render).toEqual(render);

      // An unusable custom effect is refused, and nothing is written.
      const tooLong = {
        postProcessing: { enabled: true, effects: [custom('custom-c', 1)] },
      };
      tooLong.postProcessing.effects[0]!.definition.source = 'x'.repeat(70_000);
      await expect(lib.update(id, { render: tooLong })).rejects.toMatchObject({ code: 'invalid' });
      expect((await lib.read(id)).render).toEqual(render);
    });

    // 9 & 10 — textures across all four channels, replace and clear
    it('stores, replaces and clears textures on every channel', async () => {
      const { id } = await lib.create({ name: 'Textured' });
      for (const channel of [0, 1, 2, 3]) {
        await lib.setTexture(id, channel, {
          ext: 'png',
          bytes: Buffer.from(`c${channel}`),
          width: 4,
          height: 4,
        });
      }
      const record = await lib.read(id);
      expect(record.channels.map((channel) => channel.ext)).toEqual(['png', 'png', 'png', 'png']);
      expect((await lib.readTexture(id, 2))?.bytes).toEqual(new Uint8Array(Buffer.from('c2')));

      await lib.setTexture(id, 0, {
        ext: 'jpg',
        bytes: Buffer.from('replaced'),
        width: 8,
        height: 8,
      });
      const replaced = await lib.readTexture(id, 0);
      expect(replaced?.ext).toBe('jpg');
      expect(replaced?.bytes).toEqual(new Uint8Array(Buffer.from('replaced')));

      await lib.clearTexture(id, 0);
      expect(await lib.readTexture(id, 0)).toBeNull();
      expect((await lib.read(id)).channels[0].ext).toBeNull();
    });

    // 11 — thumbnail (a preview is not an edit)
    it('stores a thumbnail without bumping updatedAt or revision', async () => {
      const created = await lib.create({ name: 'Preview' });
      const saved = await lib.setThumbnail(created.id, { ext: 'webp', bytes: Buffer.from('img') });
      expect(saved.thumbnail?.ext).toBe('webp');
      expect(saved.updatedAt).toBe(created.updatedAt);
      expect(saved.revision).toBe(created.revision);
      expect((await lib.readThumbnail(created.id))?.bytes).toEqual(
        new Uint8Array(Buffer.from('img')),
      );

      await lib.setThumbnail(created.id, { ext: 'png', bytes: Buffer.from('img2') });
      expect((await lib.readThumbnail(created.id))?.ext).toBe('png');

      const cleared = await lib.clearThumbnail(created.id);
      expect(cleared.thumbnail).toBeNull();
      expect(cleared.revision).toBe(created.revision);
      expect(await lib.readThumbnail(created.id)).toBeNull();
    });

    describe('thumbnail under expectedThumbnail', () => {
      const img = (text: string) => ({ ext: 'png', bytes: Buffer.from(text) });

      it('writes and clears only while the stored thumbnail matches', async () => {
        const created = await lib.create({ name: 'Guarded' });
        const first = await lib.setThumbnail(created.id, img('one'), null);
        const stamp = first.thumbnail!.updatedAt;
        expect(first.revision).toBe(created.revision);

        const second = await lib.setThumbnail(created.id, img('two'), stamp);
        expect(second.thumbnail!.updatedAt > stamp).toBe(true);
        expect(second.revision).toBe(created.revision);
        expect((await lib.readThumbnail(created.id))?.bytes).toEqual(
          new Uint8Array(Buffer.from('two')),
        );

        const cleared = await lib.clearThumbnail(created.id, second.thumbnail!.updatedAt);
        expect(cleared.thumbnail).toBeNull();
        expect(cleared.revision).toBe(created.revision);
        expect((await lib.clearThumbnail(created.id, null)).thumbnail).toBeNull();
      });

      it('writes nothing on a mismatch', async () => {
        const created = await lib.create({ name: 'Moved On' });
        const stored = await lib.setThumbnail(created.id, img('current'));
        const stale = '2000-01-01T00:00:00.000Z';
        const conflict = { code: 'conflict' };

        await expect(lib.setThumbnail(created.id, img('stale'), stale)).rejects.toMatchObject(
          conflict,
        );
        await expect(lib.setThumbnail(created.id, img('stale'), null)).rejects.toMatchObject(
          conflict,
        );
        await expect(lib.clearThumbnail(created.id, stale)).rejects.toMatchObject(conflict);
        await expect(lib.clearThumbnail(created.id, null)).rejects.toMatchObject(conflict);

        expect((await lib.read(created.id)).thumbnail).toEqual(stored.thumbnail);
        expect((await lib.readThumbnail(created.id))?.bytes).toEqual(
          new Uint8Array(Buffer.from('current')),
        );

        const bare = await lib.create({ name: 'Bare' });
        await expect(lib.setThumbnail(bare.id, img('x'), stale)).rejects.toMatchObject(conflict);
        await expect(lib.clearThumbnail(bare.id, stale)).rejects.toMatchObject(conflict);
        expect(await lib.readThumbnail(bare.id)).toBeNull();
      });

      it('treats another user’s shader as not found', async () => {
        const id = (await lib.as({ userId: 'user-alice' }).create({ name: 'Alice' })).id;
        const bob = lib.as({ userId: 'user-bob' });

        await expect(bob.setThumbnail(id, img('x'), null)).rejects.toMatchObject({
          code: 'not_found',
        });
        await expect(bob.clearThumbnail(id, null)).rejects.toMatchObject({ code: 'not_found' });
        expect(await lib.as({ userId: 'user-alice' }).readThumbnail(id)).toBeNull();
      });

      it('never reuses a cleared stamp, even with the clock frozen or set back', async () => {
        const created = await lib.create({ name: 'Recreated' });
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
          for (const later of ['2030-01-01T00:00:00.000Z', '2029-12-31T23:00:00.000Z']) {
            vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
            const a = (await lib.setThumbnail(created.id, img('A'))).thumbnail!.updatedAt;
            await lib.clearThumbnail(created.id);
            vi.setSystemTime(new Date(later));
            const b = (await lib.setThumbnail(created.id, img('B'))).thumbnail!.updatedAt;
            expect(b).not.toBe(a);

            // A delayed conditional write still holding A's stamp.
            await expect(lib.setThumbnail(created.id, img('late'), a)).rejects.toMatchObject({
              code: 'conflict',
            });
            await expect(lib.clearThumbnail(created.id, a)).rejects.toMatchObject({
              code: 'conflict',
            });
            expect((await lib.readThumbnail(created.id))?.bytes).toEqual(
              new Uint8Array(Buffer.from('B')),
            );
            await lib.clearThumbnail(created.id);
          }
        } finally {
          vi.useRealTimers();
        }
      });

      it('stamps strictly increasing times under a frozen clock', async () => {
        const created = await lib.create({ name: 'Frozen' });
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
          vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'));
          const one = (await lib.setThumbnail(created.id, img('1'))).thumbnail!.updatedAt;
          const two = (await lib.setThumbnail(created.id, img('2'), one)).thumbnail!.updatedAt;
          const three = (await lib.setThumbnail(created.id, img('3'))).thumbnail!.updatedAt;
          expect(one < two && two < three).toBe(true);
          // The first stamp can never match again.
          await expect(lib.setThumbnail(created.id, img('4'), one)).rejects.toMatchObject({
            code: 'conflict',
          });
        } finally {
          vi.useRealTimers();
        }
      });
    });

    // 12 & 13 — import/export v2, rename and overwrite
    it('round-trips a collection through export -> parse -> import', async () => {
      const created = await lib.create({ name: 'Round Trip' });
      await lib.update(created.id, { fragment: FRAGMENT });
      await lib.savePreset(created.id, { name: 'Warm', values: {} });
      await lib.setTexture(created.id, 0, {
        ext: 'png',
        bytes: Buffer.from('pix'),
        width: 2,
        height: 2,
      });
      await lib.setThumbnail(created.id, { ext: 'webp', bytes: Buffer.from('thumb') });

      const bundle = buildCollectionBundle(await lib.exportAll());
      const parsed = parseBundle(JSON.parse(JSON.stringify(bundle)));
      if (!parsed.ok) throw new Error(parsed.errors.join('; '));

      await lib.remove(created.id);
      await lib.importPayloads(parsed.value, 'rename');

      const imported = await lib.read(created.id);
      expect(imported.fragment).toBe(FRAGMENT);
      expect(imported.presets.map((preset) => preset.name)).toEqual(['Warm']);
      expect((await lib.readTexture(created.id, 0))?.bytes).toEqual(
        new Uint8Array(Buffer.from('pix')),
      );
      expect((await lib.readThumbnail(created.id))?.bytes).toEqual(
        new Uint8Array(Buffer.from('thumb')),
      );
    });

    it('rename mode never overwrites, overwrite mode replaces the id holder', async () => {
      await lib.create({ name: 'Keep Me' });
      const renameResult = await lib.importPayloads([payloadOf('keep-me', 'Keep Me')], 'rename');
      expect(renameResult.imported[0]).toMatchObject({ id: 'keep-me-2', replaced: false });

      const overwrite = await lib.importPayloads(
        [withTexture(payloadOf('keep-me', 'Replaced'), 0)],
        'overwrite',
      );
      expect(overwrite.imported[0]).toMatchObject({ id: 'keep-me', replaced: true });
      expect((await lib.read('keep-me')).name).toBe('Replaced');
      expect((await lib.readTexture('keep-me', 0))?.bytes).toEqual(
        new Uint8Array(Buffer.from('a fake png image')),
      );
    });

    // 12 — import a v1 bundle (no project) via the parse path that synthesises one
    it('imports a shader-studio/v1 bundle, synthesising a project', async () => {
      const v1Shader = payloadOf('legacy', 'Legacy') as Partial<ShaderPayload>;
      delete v1Shader.project;
      const bundle = {
        format: LEGACY_BUNDLE_FORMAT,
        kind: 'shader',
        exportedAt: new Date().toISOString(),
        shader: { ...v1Shader, fragment: FRAGMENT },
      };
      const parsed = parseBundle(bundle);
      if (!parsed.ok) throw new Error(parsed.errors.join('; '));
      await lib.importPayloads(parsed.value, 'rename');

      const imported = await lib.read('legacy');
      expect(imported.fragment).toBe(FRAGMENT);
      expect(imagePass(imported.project).source).toBe(FRAGMENT);
    });

    // 14 — multipass project survives a restart
    it('persists a multipass project across a restart', async () => {
      const created = await lib.create({ name: 'Multi' });
      const withBuffer = addBuffer(created.project);
      const buffer = bufferPasses(withBuffer)[0];
      const wired = setChannelBinding(
        addFile(withBuffer, 'lib.glsl'),
        imagePass(withBuffer).id,
        0,
        {
          kind: 'buffer',
          passId: buffer.id,
          feedback: true,
        },
      );
      await lib.update(created.id, { project: wired });

      await lib.close();
      const reopened = new ShaderLibrary(harness.makeRepository(), LOCAL_SCOPE);
      await reopened.init();
      try {
        expect((await reopened.read(created.id)).project).toEqual(wired);
      } finally {
        await reopened.close();
      }
    });

    // 15 — idempotent seeding
    it('seeds examples once, idempotently, and only when enabled', async () => {
      const source: PayloadSource = {
        listIds: async () => ['sample'],
        exportOne: async () => payloadOf('sample', 'Sample'),
      };

      await lib.installExamples(source, false);
      expect(await lib.list()).toEqual([]);

      await lib.installExamples(source, true);
      await lib.installExamples(source, true);
      expect((await lib.list()).map((entry) => entry.id)).toEqual(['sample']);

      await lib.remove('sample');
      await lib.installExamples(source, true);
      expect(await lib.list()).toEqual([]); // a deleted example does not come back
    });

    // 16 — rollback on a mid-transaction error
    it('rolls a failed transaction back completely', async () => {
      const repo = harness.makeRepository();
      const lib2 = new ShaderLibrary(repo, LOCAL_SCOPE);
      await lib2.init();
      try {
        await expect(
          repo.transaction(async (tx) => {
            await tx.insertShader({
              id: 'ghost',
              ownerUserId: LOCAL_USER_ID,
              kind: 'shader',
              name: 'Ghost',
              description: '',
              author: null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              revision: 1,
              projectJson: '{}',
              controlsJson: '[]',
              renderJson: '{}',
              channelsJson: '[]',
            });
            throw new Error('boom');
          }),
        ).rejects.toThrow();
        expect(await lib2.list()).toEqual([]);
      } finally {
        await lib2.close();
      }
    });

    // 17 — revision conflict
    it('detects a concurrent write via expectedRevision', async () => {
      const created = await lib.create({ name: 'Contended' });
      const first = await lib.update(created.id, { name: 'A', expectedRevision: created.revision });
      expect(first.revision).toBe(2);
      await expect(
        lib.update(created.id, { name: 'B', expectedRevision: created.revision }),
      ).rejects.toMatchObject({ code: 'conflict' });
      // Without an expectedRevision, last write wins.
      await expect(lib.update(created.id, { name: 'C' })).resolves.toMatchObject({ name: 'C' });
    });

    describe('remove under expectedRevision', () => {
      it('deletes nothing on a stale revision and deletes on a matching one', async () => {
        const { id } = await lib.create({ name: 'Doomed' });
        await lib.update(id, { name: 'Edited' });

        await expect(lib.remove(id, 1)).rejects.toMatchObject({ code: 'conflict' });
        expect((await lib.read(id)).name).toBe('Edited');

        await lib.remove(id, 2);
        await expect(lib.read(id)).rejects.toMatchObject({ code: 'not_found' });
        await expect(lib.remove(id, 2)).rejects.toMatchObject({ code: 'not_found' });
      });

      it('rejects an invalid revision and keeps the unconditional delete', async () => {
        const { id } = await lib.create({ name: 'Plain' });
        await expect(lib.remove(id, 0)).rejects.toMatchObject({ code: 'invalid' });
        await lib.update(id, { name: 'Edited' });
        await lib.remove(id);
        expect(await lib.list()).toEqual([]);
      });

      it('deletes only while the thumbnail is still the expected one', async () => {
        const bare = await lib.create({ name: 'Bare' });
        await expect(lib.remove(bare.id, 1, '2020-01-01T00:00:00.000Z')).rejects.toMatchObject({
          code: 'conflict',
        });
        await lib.remove(bare.id, 1, null);
        await expect(lib.read(bare.id)).rejects.toMatchObject({ code: 'not_found' });

        const { id } = await lib.create({ name: 'Pictured' });
        const first = await lib.setThumbnail(id, { ext: 'png', bytes: Buffer.from('a') });
        await expect(lib.remove(id, 1, null)).rejects.toMatchObject({ code: 'conflict' });
        const second = await lib.setThumbnail(id, { ext: 'png', bytes: Buffer.from('b') });
        await expect(lib.remove(id, 1, first.thumbnail!.updatedAt)).rejects.toMatchObject({
          code: 'conflict',
        });
        expect((await lib.read(id)).name).toBe('Pictured');

        await lib.remove(id, 1, second.thumbnail!.updatedAt);
        await expect(lib.read(id)).rejects.toMatchObject({ code: 'not_found' });
      });

      it('rejects an invalid expected thumbnail', async () => {
        const { id } = await lib.create({ name: 'Kept' });
        await expect(lib.remove(id, 1, '')).rejects.toMatchObject({ code: 'invalid' });
        await expect(lib.remove(id, 1, 42)).rejects.toMatchObject({ code: 'invalid' });
        expect((await lib.read(id)).name).toBe('Kept');
      });

      it('404s a foreign shader and refuses a template', async () => {
        const alice = lib.as({ userId: 'user-alice' });
        const { id } = await alice.create({ name: 'Hers' });
        await expect(lib.as({ userId: 'user-bob' }).remove(id, 1)).rejects.toMatchObject({
          code: 'not_found',
        });
        expect((await alice.read(id)).name).toBe('Hers');

        await lib
          .as({ userId: 'system' })
          .installExamples(
            { listIds: async () => ['example'], exportOne: async () => payloadOf('example', 'Ex') },
            true,
            'template',
          );
        await expect(alice.remove('example', 1)).rejects.toMatchObject({ code: 'not_found' });
        expect((await alice.read('example')).name).toBe('Ex');
      });
    });

    it('bumps the revision on every edit and reports it in the summary', async () => {
      const { id } = await lib.create({ name: 'Counted' });
      const revision = async (): Promise<number> => (await lib.read(id)).revision;
      const summaryRevision = async (): Promise<number | undefined> =>
        (await lib.list()).find((entry) => entry.id === id)?.revision;

      const steps: [string, () => Promise<unknown>][] = [
        ['update', () => lib.update(id, { fragment: FRAGMENT })],
        ['savePreset', () => lib.savePreset(id, { name: 'P', values: {} })],
        ['deletePreset', () => lib.deletePreset(id, 'p')],
        [
          'setTexture',
          () => lib.setTexture(id, 0, { ext: 'png', bytes: Buffer.from('x'), width: 1, height: 1 }),
        ],
        ['clearTexture', () => lib.clearTexture(id, 0)],
      ];
      for (const [name, step] of steps) {
        const before = await revision();
        await step();
        expect(`${name} → ${await revision()}`).toBe(`${name} → ${before + 1}`);
        expect(await summaryRevision()).toBe(await revision());
      }
    });

    // 17b — replace from a payload (what a sync client pushes)
    describe('replaceFromPayload', () => {
      async function seeded(): Promise<{ id: string; revision: number }> {
        const { id } = await lib.create({ name: 'Target' });
        await lib.savePreset(id, { name: 'Old Preset', values: {} });
        await lib.setTexture(id, 1, { ext: 'png', bytes: Buffer.from('t'), width: 1, height: 1 });
        await lib.setThumbnail(id, { ext: 'png', bytes: Buffer.from('thumb') });
        return { id, revision: (await lib.read(id)).revision };
      }

      const withThumbnail = (payload: ShaderPayload): ShaderPayload => ({
        ...payload,
        thumbnail: { ext: 'webp', updatedAt: '2000-01-01T00:00:00.000Z', data: WEBP },
      });

      it('replaces fields and children and sets revision to expected + 1', async () => {
        const { id, revision } = await seeded();
        const before = await lib.read(id);
        const payload = withTexture(
          payloadOf('ignored-id', 'Replaced', {
            fragment: FRAGMENT,
            project: migrateLegacyProject(FRAGMENT, DEFAULT_VERTEX),
            presets: [
              { id: 'new', name: 'New Preset', createdAt: new Date().toISOString(), values: {} },
            ],
          }),
          2,
        );

        const replaced = await lib.replaceFromPayload(id, payload, revision);

        expect(replaced.id).toBe(id);
        expect(replaced.kind).toBe('shader');
        expect(replaced.createdAt).toBe(before.createdAt);
        expect(replaced.revision).toBe(revision + 1);
        expect(replaced.name).toBe('Replaced');
        expect(replaced.fragment).toBe(FRAGMENT);
        expect(replaced.presets.map((preset) => preset.name)).toEqual(['New Preset']);
        expect(replaced.channels[1].ext).toBeNull();
        expect(await lib.readTexture(id, 1)).toBeNull();
        expect((await lib.readTexture(id, 2))?.bytes).toEqual(
          new Uint8Array(Buffer.from('a fake png image')),
        );
        expect((await lib.list()).find((entry) => entry.id === id)?.revision).toBe(revision + 1);
      });

      it('leaves the stored thumbnail untouched whatever the payload carries', async () => {
        const { id, revision } = await seeded();
        const before = await lib.read(id);

        for (const [step, payload] of [
          payloadOf(id, 'Without Preview'),
          withThumbnail(payloadOf(id, 'With Preview')),
        ].entries()) {
          const replaced = await lib.replaceFromPayload(id, payload, revision + step);
          expect(replaced.thumbnail).toEqual(before.thumbnail);
          expect((await lib.readThumbnail(id))?.bytes).toEqual(
            new Uint8Array(Buffer.from('thumb')),
          );
        }
      });

      it('keeps a thumbnail uploaded after the client read the revision', async () => {
        const { id, revision } = await lib.create({ name: 'Raced' });
        // The browser uploads a preview after the client read `revision`.
        const uploaded = await lib.setThumbnail(id, { ext: 'png', bytes: Buffer.from('web') });

        const replaced = await lib.replaceFromPayload(id, payloadOf(id, 'Pushed'), revision);
        expect(replaced.name).toBe('Pushed');
        expect(replaced.revision).toBe(revision + 1);
        expect(replaced.thumbnail).toEqual(uploaded.thumbnail);
        expect((await lib.readThumbnail(id))?.bytes).toEqual(new Uint8Array(Buffer.from('web')));
      });

      it('refuses a stale revision and changes nothing', async () => {
        const { id, revision } = await seeded();
        const before = await lib.read(id);

        await expect(
          lib.replaceFromPayload(id, payloadOf(id, 'Late'), revision - 1),
        ).rejects.toMatchObject({ code: 'conflict' });
        await expect(
          lib.replaceFromPayload(id, payloadOf(id, 'None'), undefined),
        ).rejects.toMatchObject({ code: 'invalid' });

        const after = await lib.read(id);
        expect(after).toEqual(before);
        expect(await lib.readTexture(id, 1)).not.toBeNull();
        expect(await lib.readThumbnail(id)).not.toBeNull();
      });

      it('404s an unknown or foreign shader and refuses a template', async () => {
        await expect(
          lib.replaceFromPayload('nope', payloadOf('nope', 'X'), 1),
        ).rejects.toMatchObject({ code: 'not_found' });

        const alice = lib.as({ userId: 'user-alice' });
        const { id } = await alice.create({ name: 'Hers' });
        await expect(
          lib.as({ userId: 'user-bob' }).replaceFromPayload(id, payloadOf(id, 'Stolen'), 1),
        ).rejects.toMatchObject({ code: 'not_found' });
        expect((await alice.read(id)).name).toBe('Hers');

        await lib
          .as({ userId: 'system' })
          .installExamples(
            { listIds: async () => ['example'], exportOne: async () => payloadOf('example', 'Ex') },
            true,
            'template',
          );
        await expect(
          alice.replaceFromPayload('example', payloadOf('example', 'Mine'), 1),
        ).rejects.toMatchObject({ code: 'invalid' });
        expect((await alice.read('example')).name).toBe('Ex');
      });
    });

    // 18 — migration from the file format (an in-memory legacy source)
    it('migrates a legacy library in one verified transaction', async () => {
      const legacy: ShaderPayload[] = [
        withTexture(payloadOf('one', 'One'), 0),
        {
          ...payloadOf('two', 'Two'),
          thumbnail: { ext: 'webp', updatedAt: new Date().toISOString(), data: WEBP },
        },
      ];
      const source: PayloadSource = {
        listIds: async () => legacy.map((payload) => payload.id),
        exportOne: async (id) => legacy.find((payload) => payload.id === id)!,
      };

      const summary = await lib.migrateLegacy(source);
      expect(summary).toEqual({ imported: 2, skipped: 0 });
      expect((await lib.list()).map((entry) => entry.id).sort()).toEqual(['one', 'two']);
      expect((await lib.readTexture('one', 0))?.bytes).toEqual(
        new Uint8Array(Buffer.from('a fake png image')),
      );
      expect((await lib.readThumbnail('two'))?.bytes).toEqual(
        new Uint8Array(Buffer.from('a fake webp preview')),
      );
    });

    // 19 — invalid / degenerate stored JSON must never crash the reader
    it('stays resilient to a corrupt project (io error or degraded, never a crash)', async () => {
      const { id } = await lib.create({ name: 'Corrupt' });
      await harness.corruptProjectJson(id);
      try {
        const record = await lib.read(id);
        // A degenerate project degrades to a valid one rather than throwing
        // (e.g. Postgres `jsonb` cannot hold invalid JSON in the first place).
        expect(record.project.passes.length).toBeGreaterThan(0);
      } catch (error) {
        expect(error).toBeInstanceOf(StorageError);
        expect((error as StorageError).code).toBe('io');
      }
    });

    // 20 — a missing asset degrades instead of crashing
    it('degrades gracefully when a channel points at a missing asset', async () => {
      const { id } = await lib.create({ name: 'Dangling' });
      await lib.setTexture(id, 0, {
        ext: 'png',
        bytes: Buffer.from('gone soon'),
        width: 2,
        height: 2,
      });
      await harness.removeAssetRow(id, 'texture:0');

      expect(await lib.readTexture(id, 0)).toBeNull();
      const payload = await lib.exportOne(id);
      expect(payload.channels[0].data).toBeNull();
    });

    // 21 — persistence across a restart
    it('persists shaders across a restart', async () => {
      const created = await lib.create({ name: 'Durable' });
      await lib.update(created.id, { fragment: FRAGMENT });
      await lib.close();

      const reopened = new ShaderLibrary(harness.makeRepository(), LOCAL_SCOPE);
      await reopened.init();
      try {
        expect((await reopened.read(created.id)).fragment).toBe(FRAGMENT);
      } finally {
        await reopened.close();
      }
    });

    // 21b — shader history (Phase 1)
    describe('history', () => {
      const SECOND = 'void main() { gl_FragColor = vec4(0.5); }';
      const THIRD = 'void main() { gl_FragColor = vec4(0.25); }';
      const revisions = async (id: string) => (await lib.listHistory(id)).map((e) => e.revision);

      /** A second library over the same store whose history inserts can be made to fail. */
      async function failingLibrary(): Promise<{ failing: ShaderLibrary; armed: { on: boolean } }> {
        const armed = { on: false };
        const repo = harness.makeRepository();
        const wrapTx = (tx: ShaderTx): ShaderTx =>
          new Proxy(tx, {
            get(target, prop) {
              if (prop === 'insertHistory' && armed.on) {
                return async () => {
                  throw new StorageError('io', 'history insert failed');
                };
              }
              const value = Reflect.get(target, prop) as unknown;
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        const proxy = new Proxy(repo, {
          get(target, prop) {
            if (prop === 'transaction') {
              return <T>(work: (tx: ShaderTx) => Promise<T>) =>
                target.transaction((tx) => work(wrapTx(tx)));
            }
            const value = Reflect.get(target, prop) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        const failing = new ShaderLibrary(proxy, LOCAL_SCOPE);
        await failing.init();
        return { failing, armed };
      }

      it('records an initial entry for a new shader and one per source/config/render save', async () => {
        const created = await lib.create({ name: 'Timeline' });
        expect(await lib.listHistory(created.id)).toEqual([
          {
            revision: 1,
            createdAt: created.createdAt,
            cause: 'create',
            checkpointName: null,
            restoredFromRevision: null,
          },
        ]);

        await lib.update(created.id, { fragment: SECOND });
        await lib.update(created.id, { render: { ...DEFAULT_RENDER } });
        await lib.update(created.id, {
          controls: [{ key: 'speed', type: 'number', default: 1, min: 0, max: 2 }],
        });
        const history = await lib.listHistory(created.id);
        expect(history.map((entry) => entry.revision)).toEqual([4, 3, 2, 1]);
        expect(history.map((entry) => entry.cause)).toEqual([
          'update',
          'update',
          'update',
          'create',
        ]);
      });

      it('lists newest first and survives a restart', async () => {
        const { id } = await lib.create({ name: 'Durable History' });
        await lib.update(id, { fragment: SECOND });
        await lib.setCheckpoint(id, 1, 'Start');
        await lib.close();

        const reopened = new ShaderLibrary(harness.makeRepository(), LOCAL_SCOPE);
        await reopened.init();
        try {
          const history = await reopened.listHistory(id);
          expect(history.map((entry) => entry.revision)).toEqual([2, 1]);
          expect(history[1]?.checkpointName).toBe('Start');
        } finally {
          await reopened.close();
        }
      });

      it('records preset save and delete, and the entry holds the presets of that moment', async () => {
        const { id } = await lib.create({ name: 'Presets' });
        const saved = await lib.savePreset(id, { name: 'Warm', values: {} });
        await lib.deletePreset(id, saved.id);

        const history = await lib.listHistory(id);
        expect(history.map((entry) => entry.cause)).toEqual([
          'preset-delete',
          'preset-save',
          'create',
        ]);

        // Restoring the entry written by the save brings the preset back.
        const head = (await lib.read(id)).revision;
        const restored = await lib.restoreHistory(id, 2, head);
        expect(restored.presets.map((preset) => preset.name)).toEqual(['Warm']);
        // ...and restoring the creation state drops it again.
        const emptied = await lib.restoreHistory(id, 1, restored.revision);
        expect(emptied.presets).toEqual([]);
      });

      it('does not record texture, channel, metadata or thumbnail writes, leaving revision gaps', async () => {
        const { id } = await lib.create({ name: 'Gaps' });
        await lib.update(id, { name: 'Gaps Renamed', description: 'd' });
        await lib.update(id, {
          channels: [{ wrap: 'repeat' }, {}, {}, {}],
        });
        await lib.setTexture(id, 0, { ext: 'png', bytes: Buffer.from('t'), width: 1, height: 1 });
        await lib.clearTexture(id, 0);
        await lib.setThumbnail(id, { ext: 'png', bytes: Buffer.from('thumb') });
        await lib.clearThumbnail(id);
        expect(await revisions(id)).toEqual([1]);

        const edited = await lib.update(id, { fragment: SECOND });
        expect(edited.revision).toBeGreaterThan(2);
        expect(await revisions(id)).toEqual([edited.revision, 1]);
      });

      it('freezes the head exactly as it was written', async () => {
        const { id } = await lib.create({ name: 'Frozen' });
        const edited = await lib.update(id, { fragment: SECOND });
        await lib.update(id, { fragment: THIRD });

        const restored = await lib.restoreHistory(
          id,
          edited.revision,
          (await lib.read(id)).revision,
        );
        expect(restored.fragment).toBe(SECOND);
        expect(restored.project).toEqual(edited.project);
        expect(restored.controls).toEqual(edited.controls);
        expect(restored.render).toEqual(edited.render);
      });

      it('captures a baseline for a pre-feature shader before its first versioned mutation', async () => {
        const mutations = [
          (id: string) => lib.update(id, { fragment: SECOND }),
          (id: string) => lib.savePreset(id, { name: 'P', values: {} }),
        ];
        for (const [index, mutate] of mutations.entries()) {
          const { id } = await lib.create({ name: `Legacy ${index}` });
          await harness.clearHistory(id);
          expect(await lib.listHistory(id)).toEqual([]);

          // Metadata-only writes are not versioned, so they do not capture it.
          await lib.update(id, { description: 'touch' });
          expect(await lib.listHistory(id)).toEqual([]);

          await mutate(id);
          const history = await lib.listHistory(id);
          expect(history.map((entry) => entry.cause)).toEqual([expect.any(String), 'baseline']);
          const baseline = history[1];
          expect(baseline?.revision).toBe(2);

          const restored = await lib.restoreHistory(id, 2, (await lib.read(id)).revision);
          expect(restored.fragment).toBe(TEMPLATE_FRAGMENT);
          expect(restored.presets).toEqual([]);
        }
      });

      it('does not capture a baseline when the mutation is rejected', async () => {
        const { id } = await lib.create({ name: 'Rejected' });
        await harness.clearHistory(id);
        await expect(
          lib.update(id, { fragment: SECOND, expectedRevision: 99 }),
        ).rejects.toMatchObject({ code: 'conflict' });
        expect(await harness.countHistory(id)).toBe(0);
        expect((await lib.read(id)).revision).toBe(1);
      });

      it('starts imported, overwritten and duplicated shaders with history', async () => {
        await lib.importPayloads([payloadOf('imp', 'Imp')], 'rename');
        expect((await lib.listHistory('imp')).map((e) => [e.revision, e.cause])).toEqual([
          [1, 'import'],
        ]);

        await lib.update('imp', { fragment: SECOND });
        await lib.importPayloads([payloadOf('imp', 'Imp')], 'overwrite');
        expect((await lib.listHistory('imp')).map((e) => [e.revision, e.cause])).toEqual([
          [1, 'import'],
        ]);

        const copy = await lib.duplicate('imp', 'Imp Copy');
        expect((await lib.listHistory(copy.id)).map((e) => [e.revision, e.cause])).toEqual([
          [1, 'duplicate'],
        ]);
      });

      it('records a whole-shader replace', async () => {
        const { id } = await lib.create({ name: 'Synced' });
        const payload = await lib.exportOne(id);
        const replaced = await lib.replaceFromPayload(
          id,
          {
            ...payload,
            fragment: SECOND,
            project: setPassSource(payload.project, imagePass(payload.project).id, SECOND),
          },
          1,
        );
        const history = await lib.listHistory(id);
        expect(history.map((entry) => [entry.revision, entry.cause])).toEqual([
          [replaced.revision, 'sync'],
          [1, 'create'],
        ]);
      });

      it('rolls the mutation back when its snapshot cannot be written', async () => {
        const { id } = await lib.create({ name: 'Atomic' });
        const before = await lib.read(id);
        const { failing, armed } = await failingLibrary();
        try {
          armed.on = true;
          await expect(failing.update(id, { fragment: SECOND })).rejects.toMatchObject({
            code: 'io',
          });
          await expect(failing.savePreset(id, { name: 'P', values: {} })).rejects.toThrow();
          await expect(failing.restoreHistory(id, 1, before.revision)).rejects.toThrow();
          await expect(failing.create({ name: 'Never' })).rejects.toThrow();

          expect(await lib.read(id)).toEqual(before);
          expect(await revisions(id)).toEqual([1]);
          await expect(lib.read('never')).rejects.toMatchObject({ code: 'not_found' });
          expect((await lib.list()).map((entry) => entry.id)).toEqual([id]);
        } finally {
          await failing.close();
        }
      });

      it('names and clears a checkpoint without touching the shader or the entry', async () => {
        const { id } = await lib.create({ name: 'Names' });
        const edited = await lib.update(id, { fragment: SECOND });
        const before = await lib.read(id);

        const named = await lib.setCheckpoint(id, 1, '  First light  ');
        expect(named).toMatchObject({ revision: 1, checkpointName: 'First light' });
        expect(await lib.read(id)).toEqual(before);
        expect(edited.revision).toBe(2);
        expect((await lib.listHistory(id)).map((e) => e.checkpointName)).toEqual([
          null,
          'First light',
        ]);

        const cleared = await lib.setCheckpoint(id, 1, null);
        expect(cleared.checkpointName).toBeNull();
        expect(await lib.read(id)).toEqual(before);
      });

      it('rejects bad checkpoint input and unknown entries', async () => {
        const { id } = await lib.create({ name: 'Bad Names' });
        for (const name of ['', '   ', 'x'.repeat(500), 7, undefined, 'a\u0000b']) {
          await expect(lib.setCheckpoint(id, 1, name)).rejects.toMatchObject({ code: 'invalid' });
        }
        for (const revision of [0, -1, 1.5, '1', null, undefined]) {
          await expect(lib.setCheckpoint(id, revision, 'ok')).rejects.toMatchObject({
            code: 'invalid',
          });
          await expect(lib.restoreHistory(id, revision, 1)).rejects.toMatchObject({
            code: 'invalid',
          });
        }
        await expect(lib.setCheckpoint(id, 9, 'ok')).rejects.toMatchObject({ code: 'not_found' });
        await expect(lib.setCheckpoint('nope', 1, 'ok')).rejects.toMatchObject({
          code: 'not_found',
        });
        await expect(lib.listHistory('nope')).rejects.toMatchObject({ code: 'not_found' });
        expect((await lib.listHistory(id))[0]?.checkpointName).toBeNull();
      });

      it('keeps every named checkpoint and only the newest 50 unnamed entries', async () => {
        const { id } = await lib.create({ name: 'Retention' });
        await lib.update(id, { fragment: `${FRAGMENT} // 1` });
        await lib.setCheckpoint(id, 2, 'Keep me');
        await lib.setCheckpoint(id, 1, 'And me');

        let head = 2;
        for (let n = 2; n <= 60; n += 1) {
          head = (await lib.update(id, { fragment: `${FRAGMENT} // ${n}` })).revision;
        }
        expect(head).toBe(61);

        const history = await lib.listHistory(id);
        const named = history.filter((entry) => entry.checkpointName !== null);
        const unnamed = history.filter((entry) => entry.checkpointName === null);
        expect(named.map((entry) => entry.revision)).toEqual([2, 1]);
        expect(unnamed).toHaveLength(50);
        // The newest unnamed run is contiguous and ends at the head.
        expect(unnamed[0]?.revision).toBe(61);
        expect(unnamed.at(-1)?.revision).toBe(12);
        // Descending order across the whole list.
        const all = history.map((entry) => entry.revision);
        expect(all).toEqual([...all].sort((a, b) => b - a));

        // A pruned entry cannot be restored; a kept old one still can.
        await expect(lib.restoreHistory(id, 3, head)).rejects.toMatchObject({ code: 'not_found' });
        const back = await lib.restoreHistory(id, 1, head);
        expect(back.fragment).toBe(TEMPLATE_FRAGMENT);
      });

      it('lets a cleared checkpoint age out on the next save', async () => {
        const { id } = await lib.create({ name: 'Aging' });
        await lib.setCheckpoint(id, 1, 'Temporary');
        for (let n = 0; n < 50; n += 1) await lib.update(id, { fragment: `${FRAGMENT} // ${n}` });
        expect((await lib.listHistory(id)).at(-1)?.revision).toBe(1);

        await lib.setCheckpoint(id, 1, null);
        expect((await lib.listHistory(id)).at(-1)?.revision).toBe(1); // clearing never deletes
        await lib.update(id, { fragment: `${FRAGMENT} // last` });
        const history = await lib.listHistory(id);
        expect(history).toHaveLength(50);
        expect(history.at(-1)?.revision).toBe(3);
      });

      it('restores into a new head, linked to its source, without rewriting history', async () => {
        const { id } = await lib.create({ name: 'Restorable' });
        await lib.update(id, { fragment: SECOND });
        await lib.update(id, { fragment: THIRD });
        await lib.setCheckpoint(id, 1, 'Original');
        const before = await lib.listHistory(id);

        const restored = await lib.restoreHistory(id, 1, 3);
        expect(restored.revision).toBe(4);
        expect(restored.fragment).toBe(TEMPLATE_FRAGMENT);

        const after = await lib.listHistory(id);
        expect(after).toHaveLength(before.length + 1);
        expect(after[0]).toMatchObject({
          revision: 4,
          cause: 'restore',
          restoredFromRevision: 1,
          checkpointName: null,
        });
        // Everything that existed is untouched, newest-first order included.
        expect(after.slice(1)).toEqual(before);
        expect((await lib.read(id)).revision).toBe(4);

        // The source can still be restored again later.
        const again = await lib.restoreHistory(id, 3, 4);
        expect(again.fragment).toBe(THIRD);
      });

      it('keeps identity, metadata, channels, texture bytes and thumbnail across a restore', async () => {
        const { id } = await lib.create({ name: 'Keeper' });
        await lib.update(id, { fragment: SECOND });
        await lib.update(id, { name: 'Renamed', description: 'later' });
        await lib.update(id, { channels: [{ wrap: 'repeat', filter: 'nearest' }, {}, {}, {}] });
        await lib.setTexture(id, 2, {
          ext: 'png',
          bytes: Buffer.from('bytes'),
          width: 3,
          height: 3,
        });
        await lib.setThumbnail(id, { ext: 'png', bytes: Buffer.from('thumb') });
        const current = await lib.read(id);

        const restored = await lib.restoreHistory(id, 1, current.revision);
        expect(restored.fragment).toBe(TEMPLATE_FRAGMENT);
        expect(restored.id).toBe(id);
        expect(restored.name).toBe('Renamed');
        expect(restored.description).toBe('later');
        expect(restored.createdAt).toBe(current.createdAt);
        expect(restored.channels).toEqual(current.channels);
        expect(restored.thumbnail).toEqual(current.thumbnail);
        expect(restored.revision).toBe(current.revision + 1);
        expect((await lib.readTexture(id, 2))?.bytes).toEqual(new Uint8Array(Buffer.from('bytes')));
        expect((await lib.readThumbnail(id))?.bytes).toEqual(new Uint8Array(Buffer.from('thumb')));
      });

      it('restores controls with the presets that matched them', async () => {
        const speed = { key: 'speed', type: 'number', default: 1, min: 0, max: 2 } as const;
        const { id } = await lib.create({ name: 'Matching', controls: [speed] });
        await lib.savePreset(id, { name: 'Fast', values: { speed: 2 } });
        await lib.update(id, { controls: [{ ...speed, key: 'zoom' }] });
        expect((await lib.read(id)).presets[0]?.values).toEqual({ zoom: 1 });

        const restored = await lib.restoreHistory(id, 2, (await lib.read(id)).revision);
        expect(restored.controls.map((control) => control.key)).toEqual(['speed']);
        expect(restored.presets.map((preset) => [preset.name, preset.values])).toEqual([
          ['Fast', { speed: 2 }],
        ]);
      });

      it('refuses a stale or missing expectedRevision and changes nothing', async () => {
        const { id } = await lib.create({ name: 'Guarded' });
        await lib.update(id, { fragment: SECOND });
        const before = await lib.read(id);
        const history = await lib.listHistory(id);

        await expect(lib.restoreHistory(id, 1, 1)).rejects.toMatchObject({ code: 'conflict' });
        await expect(lib.restoreHistory(id, 1, 99)).rejects.toMatchObject({ code: 'conflict' });
        await expect(lib.restoreHistory(id, 1, undefined)).rejects.toMatchObject({
          code: 'invalid',
        });
        await expect(lib.restoreHistory(id, 1, 'x')).rejects.toMatchObject({ code: 'invalid' });
        await expect(lib.restoreHistory(id, 9, before.revision)).rejects.toMatchObject({
          code: 'not_found',
        });
        await expect(lib.restoreHistory('nope', 1, 1)).rejects.toMatchObject({
          code: 'not_found',
        });

        expect(await lib.read(id)).toEqual(before);
        expect(await lib.listHistory(id)).toEqual(history);
      });

      it('refuses a corrupt entry without writing', async () => {
        const { id } = await lib.create({ name: 'Corrupt Entry' });
        await lib.update(id, { fragment: SECOND });
        await harness.corruptHistory(id, 1);
        const before = await lib.read(id);

        await expect(lib.restoreHistory(id, 1, before.revision)).rejects.toMatchObject({
          code: 'io',
        });
        expect(await lib.read(id)).toEqual(before);
        expect(await revisions(id)).toEqual([2, 1]);
      });

      it('deletes history with its shader', async () => {
        const { id } = await lib.create({ name: 'Cascade' });
        await lib.update(id, { fragment: SECOND });
        await lib.setCheckpoint(id, 1, 'Named');
        expect(await harness.countHistory(id)).toBe(2);

        await lib.remove(id);
        expect(await harness.countHistory(id)).toBe(0);
        await expect(lib.listHistory(id)).rejects.toMatchObject({ code: 'not_found' });

        // A new shader under the same id starts from revision 1 again.
        const again = await lib.create({ name: 'Cascade' });
        expect(again.id).toBe(id);
        expect(await revisions(id)).toEqual([1]);
      });

      it('keeps history behind the owner', async () => {
        const alice = lib.as({ userId: 'history-alice' });
        const bob = lib.as({ userId: 'history-bob' });
        const { id } = await alice.create({ name: 'Private History' });
        await alice.update(id, { fragment: SECOND });

        await expect(bob.listHistory(id)).rejects.toMatchObject({ code: 'not_found' });
        await expect(bob.setCheckpoint(id, 1, 'Mine')).rejects.toMatchObject({
          code: 'not_found',
        });
        await expect(bob.restoreHistory(id, 1, 2)).rejects.toMatchObject({ code: 'not_found' });
        expect((await alice.listHistory(id)).map((entry) => entry.checkpointName)).toEqual([
          null,
          null,
        ]);
        expect((await alice.read(id)).revision).toBe(2);
      });

      it('lists a shared template read-only and refuses to name or restore it', async () => {
        const source: PayloadSource = {
          listIds: async () => ['history-example'],
          exportOne: async () => payloadOf('history-example', 'History Example'),
        };
        await lib.as({ userId: 'system' }).installExamples(source, true, 'template');
        const viewer = lib.as({ userId: 'history-viewer' });

        expect((await viewer.listHistory('history-example')).map((e) => e.revision)).toEqual([1]);
        await expect(viewer.setCheckpoint('history-example', 1, 'Mine')).rejects.toMatchObject({
          code: 'not_found',
        });
        await expect(viewer.restoreHistory('history-example', 1, 1)).rejects.toMatchObject({
          code: 'invalid',
        });
      });

      it('gives a template fork its own history', async () => {
        const source: PayloadSource = {
          listIds: async () => ['fork-example'],
          exportOne: async () => payloadOf('fork-example', 'Fork Example'),
        };
        await lib.as({ userId: 'system' }).installExamples(source, true, 'template');
        const forked = await lib.as({ userId: 'history-forker' }).update('fork-example', {
          fragment: SECOND,
        });

        const history = await lib.as({ userId: 'history-forker' }).listHistory(forked.id);
        expect(history.map((entry) => entry.cause)).toEqual(['update', 'duplicate']);
      });
    });

    // 22 — ownership: two users share a store and never see each other
    describe('ownership', () => {
      const ALICE = { userId: 'user-alice' };
      const BOB = { userId: 'user-bob' };

      async function aliceShader(name = 'Alice Only'): Promise<string> {
        return (await lib.as(ALICE).create({ name })).id;
      }

      it('lists only the shaders the scope owns', async () => {
        await lib.as(ALICE).create({ name: 'Alpha' });
        await lib.as(BOB).create({ name: 'Beta' });

        expect((await lib.as(ALICE).list()).map((entry) => entry.name)).toEqual(['Alpha']);
        expect((await lib.as(BOB).list()).map((entry) => entry.name)).toEqual(['Beta']);
      });

      it('reports another user’s shader as not found, never as forbidden', async () => {
        const id = await aliceShader();
        // The same code and message a genuinely unknown id produces, so a probe
        // cannot distinguish "exists but not yours" from "does not exist".
        const failure = async (target: string): Promise<StorageError> => {
          try {
            await lib.as(BOB).read(target);
          } catch (error) {
            return error as StorageError;
          }
          throw new Error(`reading "${target}" as Bob should have failed`);
        };

        const missing = await failure('no-such-shader');
        const foreign = await failure(id);

        expect(foreign).toBeInstanceOf(StorageError);
        expect(foreign.code).toBe(missing.code);
        expect(foreign.status).toBe(missing.status);
      });

      it('refuses every cross-user mutation', async () => {
        const id = await aliceShader();
        const bob = lib.as(BOB);

        await expect(bob.update(id, { name: 'Stolen' })).rejects.toMatchObject({
          code: 'not_found',
        });
        await expect(bob.remove(id)).rejects.toMatchObject({ code: 'not_found' });
        await expect(bob.duplicate(id)).rejects.toMatchObject({ code: 'not_found' });
        await expect(bob.exportOne(id)).rejects.toMatchObject({ code: 'not_found' });
        await expect(bob.savePreset(id, { name: 'Nope', values: {} })).rejects.toMatchObject({
          code: 'not_found',
        });
        await expect(bob.deletePreset(id, 'nope')).rejects.toMatchObject({ code: 'not_found' });
        await expect(bob.clearTexture(id, 0)).rejects.toMatchObject({ code: 'not_found' });
        await expect(
          bob.setThumbnail(id, { ext: 'png', bytes: Buffer.from('x') }),
        ).rejects.toMatchObject({ code: 'not_found' });

        // Alice's shader survived every attempt untouched.
        expect((await lib.as(ALICE).read(id)).name).toBe('Alice Only');
      });

      it('keeps nested assets behind the parent shader’s owner', async () => {
        const id = await aliceShader();
        await lib.as(ALICE).setTexture(id, 0, {
          ext: 'png',
          bytes: Buffer.from(PNG, 'base64'),
          width: 2,
          height: 2,
        });
        await lib.as(ALICE).setThumbnail(id, { ext: 'webp', bytes: Buffer.from(WEBP, 'base64') });

        expect(await lib.as(BOB).readTexture(id, 0)).toBeNull();
        expect(await lib.as(BOB).readThumbnail(id)).toBeNull();
        expect(await lib.as(ALICE).readTexture(id, 0)).not.toBeNull();
      });

      it('assigns the acting user as owner on create, duplicate and import', async () => {
        const created = await lib.as(ALICE).create({ name: 'Mine' });
        const copy = await lib.as(ALICE).duplicate(created.id, 'Mine Copy');
        await lib.as(BOB).importPayloads([payloadOf('shared-id', 'Bobs Import')], 'rename');

        expect((await lib.as(ALICE).list()).map((entry) => entry.id).sort()).toEqual(
          [created.id, copy.id].sort(),
        );
        expect((await lib.as(BOB).list()).map((entry) => entry.name)).toEqual(['Bobs Import']);
      });

      it('never lets exportAll cross an ownership boundary', async () => {
        await lib.as(ALICE).create({ name: 'Alpha' });
        await lib.as(BOB).create({ name: 'Beta' });

        expect((await lib.as(ALICE).exportAll()).map((entry) => entry.name)).toEqual(['Alpha']);
        expect((await lib.as(BOB).exportAll()).map((entry) => entry.name)).toEqual(['Beta']);
      });

      it('keeps revision conflicts working inside a scope', async () => {
        const id = await aliceShader();
        const alice = lib.as(ALICE);
        const first = await alice.update(id, { name: 'Once', expectedRevision: 1 });

        await expect(
          alice.update(id, { name: 'Twice', expectedRevision: 1 }),
        ).rejects.toMatchObject({ code: 'conflict' });
        expect(first.revision).toBe(2);
      });

      describe('templates', () => {
        const source: PayloadSource = {
          listIds: async () => ['example'],
          exportOne: async () => payloadOf('example', 'Bundled Example'),
        };

        beforeEach(async () => {
          await lib.as({ userId: 'system' }).installExamples(source, true, 'template');
        });

        it('omits old shared templates from libraries and collection exports', async () => {
          for (const who of [ALICE, BOB]) {
            expect(await lib.as(who).list()).toEqual([]);
            expect(await lib.as(who).exportAll()).toEqual([]);
          }
        });

        it('forks a template on the first edit instead of writing to it', async () => {
          const edited = await lib.as(ALICE).update('example', { name: 'My Version' });

          expect(edited.id).not.toBe('example');
          expect(edited.kind).toBe('shader');
          expect(edited.name).toBe('My Version');

          // The example is untouched, and Bob sees no trace of Alice's copy.
          expect((await lib.as(BOB).read('example')).name).toBe('Bundled Example');
          expect(await lib.as(BOB).list()).toEqual([]);
          expect((await lib.as(ALICE).list()).map((entry) => entry.id)).toEqual([edited.id]);

          // Subsequent saves update the personal copy rather than forking again.
          const saved = await lib.as(ALICE).update(edited.id, {
            fragment: FRAGMENT,
            expectedRevision: edited.revision,
          });
          expect(saved.id).toBe(edited.id);
          expect((await lib.as(ALICE).list()).map((entry) => entry.id)).toEqual([edited.id]);
          expect((await lib.as(ALICE).exportAll()).map((entry) => entry.id)).toEqual([edited.id]);
        });

        it('refuses to delete a template', async () => {
          await expect(lib.as(ALICE).remove('example')).rejects.toMatchObject({
            code: 'not_found',
          });
          expect((await lib.as(BOB).read('example')).name).toBe('Bundled Example');
        });
      });

      it('gives a second user their own id when a slug is globally taken', async () => {
        const mine = await lib.as(ALICE).create({ name: 'Nebula' });
        const theirs = await lib.as(BOB).create({ name: 'Nebula' });

        expect(mine.id).toBe('nebula');
        expect(theirs.id).not.toBe('nebula');
        expect(theirs.id.startsWith('nebula-')).toBe(true);
        expect((await lib.as(BOB).read(theirs.id)).name).toBe('Nebula');
      });
    });
  });
}
