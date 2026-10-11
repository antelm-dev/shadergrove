/**
 * The behavioural suite for publications, run against every storage engine
 * exactly like `library/conformance.ts`: one set of assertions, two backends.
 * It drives a real `PublicationLibrary` over a real `ShaderLibrary`, with three
 * accounts — two publishers and a moderator — because nearly every claim worth
 * making here is about what one of them cannot do to, or see of, another.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ShaderRecord } from '@shadergrove/shared/model';
import type { PublicationPage } from '@shadergrove/shared/publication';

import { ShaderLibrary } from '../library/shader-library';
import type { ShaderRepository } from '../persistence/shader-repository';
import { PublicationLibrary } from './publication-library';
import type { PublicationRepository } from './publication-store';

export interface PublicationHarness {
  /** A repository over this harness's (empty) store. */
  makeRepository(): ShaderRepository & PublicationRepository;
  /** Drops the store and releases resources. */
  cleanup(): Promise<void>;
  /** Inserts an account row directly; the store must already be initialised. */
  addUser(id: string): Promise<void>;
  /** Deletes an account the way account deletion does: its shaders, then the account. */
  removeUser(id: string): Promise<void>;
  /** Sets a publication's times directly, so orders and ties do not depend on the clock. */
  stamp(id: string, publishedAt: string, updatedAt: string): Promise<void>;
}

const ALICE = 'alice';
const BOB = 'bob';
const ADMIN = 'moderator';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const PNG_2 = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9]);

const terms = (extra: object = {}) => ({
  authorLabel: 'Alice A.',
  license: 'CC-BY-4.0',
  rightsConfirmed: true,
  ...extra,
});

export function runPublicationConformance(
  engine: string,
  newHarness: () => PublicationHarness,
): void {
  describe(`PublicationLibrary conformance (${engine})`, () => {
    let harness: PublicationHarness;
    let repo: ShaderRepository & PublicationRepository;
    let alice: ShaderLibrary;
    let bob: ShaderLibrary;
    let pubs: PublicationLibrary;

    beforeEach(async () => {
      harness = newHarness();
      repo = harness.makeRepository();
      alice = new ShaderLibrary(repo, { userId: ALICE });
      await alice.init();
      for (const user of [ALICE, BOB, ADMIN]) await harness.addUser(user);
      bob = alice.as({ userId: BOB });
      pubs = new PublicationLibrary(repo, alice);
    });

    afterEach(async () => {
      await alice.close().catch(() => undefined);
      await harness.cleanup();
    });

    /** A textured shader with a preset, a thumbnail and a non-default render chain. */
    async function textured(name = 'Aurora'): Promise<ShaderRecord> {
      const { id } = await alice.create({ name, description: 'A demo' });
      await alice.setTexture(id, 1, { ext: 'png', bytes: PNG, width: 2, height: 2 });
      await alice.savePreset(id, { name: 'Warm', values: {} });
      await alice.setThumbnail(id, { ext: 'png', bytes: PNG });
      return alice.read(id);
    }

    async function published(name = 'Aurora'): Promise<{ shader: ShaderRecord; id: string }> {
      const shader = await textured(name);
      const { publication } = await pubs.publish(
        ALICE,
        shader.id,
        terms({ expectedRevision: shader.revision }),
      );
      return { shader, id: publication.id };
    }

    const code = (work: Promise<unknown>) =>
      work.then(
        () => 'ok',
        (error: { code?: string }) => error.code,
      );

    /** Every public way to reach a publication, as one list of outcomes. */
    const publicReads = (id: string) =>
      Promise.all([
        code(pubs.readPublic(id)),
        code(pubs.readPublicAsset(id, 'texture:1')),
        code(pubs.readPublicAsset(id, 'thumbnail')),
        code(pubs.exportPublic(id)),
        code(pubs.copy(BOB, id)),
        pubs.listPublic({}).then((page) => (page.publications.length ? 'ok' : 'not_found')),
      ]);
    const ALL_OK = Array<string>(6).fill('ok');
    const ALL_GONE = Array<string>(6).fill('not_found');

    // --- AC-SNAPSHOT ---------------------------------------------------------

    it('publishes a coherent snapshot under an opaque id', async () => {
      const { shader, id } = await published();

      expect(id).toMatch(/^[a-f0-9]{20}$/);
      const detail = await pubs.readPublic(id);
      expect(detail).toMatchObject({
        id,
        title: 'Aurora',
        authorLabel: 'Alice A.',
        license: 'CC-BY-4.0',
        revision: 1,
        hasThumbnail: true,
      });
      expect(detail.shader.id).toBe(id);
      expect(detail.shader.presets.map((preset) => preset.name)).toEqual(['Warm']);
      expect(detail.shader.render).toEqual(shader.render);
      expect(detail.shader.project).toEqual(shader.project);
      expect(detail.shader.channels[1]).toMatchObject({ ext: 'png', data: null });
      // Nothing public names the private shader or its owner.
      expect(JSON.stringify(detail)).not.toContain(shader.id);
      expect(JSON.stringify(await pubs.listPublic({}))).not.toContain(ALICE);

      expect((await pubs.readPublicAsset(id, 'texture:1')).bytes).toEqual(PNG);
      const exported = await pubs.exportPublic(id);
      expect(exported.shader.channels[1].data).toBe(Buffer.from(PNG).toString('base64'));
      expect(exported.shader.thumbnail?.data).toBe(Buffer.from(PNG).toString('base64'));
    });

    it('refuses a stale revision, missing terms and a shader that is not the caller’s', async () => {
      const shader = await textured();
      const publish = (user: string, input: Record<string, unknown>) =>
        code(pubs.publish(user, shader.id, input));

      expect(await publish(ALICE, terms({ expectedRevision: shader.revision - 1 }))).toBe(
        'conflict',
      );
      expect(
        await publish(ALICE, terms({ expectedRevision: shader.revision, license: 'WTFPL' })),
      ).toBe('invalid');
      expect(
        await publish(ALICE, terms({ expectedRevision: shader.revision, rightsConfirmed: 'yes' })),
      ).toBe('invalid');
      expect(await publish(BOB, terms({ expectedRevision: shader.revision }))).toBe('not_found');
      expect((await pubs.listPublic({})).publications).toEqual([]);
    });

    it('leaves the snapshot alone until an explicit update, which keeps the public id', async () => {
      const { shader, id } = await published();

      await alice.update(shader.id, { name: 'Aurora II' });
      await alice.setTexture(shader.id, 1, { ext: 'png', bytes: PNG_2, width: 4, height: 4 });
      await alice.clearThumbnail(shader.id);
      expect(await pubs.readPublic(id)).toMatchObject({ title: 'Aurora', revision: 1 });
      expect((await pubs.readPublicAsset(id, 'texture:1')).bytes).toEqual(PNG);
      expect((await pubs.readPublicAsset(id, 'thumbnail')).bytes).toEqual(PNG);

      const current = await alice.read(shader.id);
      const updated = await pubs.publish(
        ALICE,
        shader.id,
        terms({ expectedRevision: current.revision }),
      );
      expect(updated).toMatchObject({ created: false, publication: { id, revision: 2 } });
      expect(await pubs.readPublic(id)).toMatchObject({ title: 'Aurora II', hasThumbnail: false });
      expect((await pubs.readPublicAsset(id, 'texture:1')).bytes).toEqual(PNG_2);
      expect(await code(pubs.readPublicAsset(id, 'thumbnail'))).toBe('not_found');
    });

    it('never cuts a torn snapshot while the source is being written', async () => {
      const { id: shaderId } = await alice.create({ name: 'Contended' });
      for (let round = 0; round < 8; round += 1) {
        const bytes = new Uint8Array([round + 1, round + 1]);
        const { revision } = await alice.read(shaderId);
        const [publish] = await Promise.allSettled([
          pubs.publish(ALICE, shaderId, terms({ expectedRevision: revision })),
          alice.setTexture(shaderId, 0, { ext: 'png', bytes, width: round + 1, height: 1 }),
          alice.setThumbnail(shaderId, { ext: 'png', bytes }),
        ]);
        if (publish.status === 'rejected') {
          expect((publish.reason as { code?: string }).code).toBe('conflict');
          continue;
        }
        // Whichever side of the writes it landed on, metadata and bytes agree.
        const { id } = publish.value.publication;
        const channel = (await pubs.readPublic(id)).shader.channels[0];
        const asset = await pubs.readPublicAsset(id, 'texture:0').catch(() => null);
        expect(channel.ext === null).toBe(asset === null);
        if (asset) expect(asset.bytes.length).toBe(2);
        if (asset) expect(channel.width).toBe(asset.bytes[0]);
      }
    });

    it('never pairs one revision’s credits with another revision’s sources', async () => {
      const { id: shaderId } = await alice.create({ name: 'Rev 0' });
      await pubs.publish(ALICE, shaderId, terms({ expectedRevision: 1 }));
      const { id } = (await pubs.status(ALICE, shaderId)).publication!;

      for (let round = 1; round <= 8; round += 1) {
        const { revision } = await alice.update(shaderId, { name: `Rev ${round}` });
        const [, ...reads] = await Promise.all([
          pubs.publish(ALICE, shaderId, terms({ expectedRevision: revision })),
          ...Array.from({ length: 6 }, () => pubs.readPublic(id)),
          pubs.adminRead(id),
        ]);
        // Whichever side of the update a read landed on, it is all from that side.
        for (const detail of reads) expect(detail.shader.name).toBe(detail.title);
      }
    });

    // --- AC-LIFECYCLE / AC-PRIVACY ------------------------------------------

    it('hides an unpublished publication everywhere and brings it back under the same id', async () => {
      const { shader, id } = await published();
      expect(await publicReads(id)).toEqual(ALL_OK);

      expect(await code(pubs.unpublish(BOB, shader.id))).toBe('not_found');
      expect((await pubs.unpublish(ALICE, shader.id)).ownerVisible).toBe(false);
      expect(await publicReads(id)).toEqual(ALL_GONE);
      expect(await code(pubs.readPublic('0'.repeat(20)))).toBe('not_found');
      expect(await code(pubs.readPublic('../etc'))).toBe('not_found');

      const again = await pubs.publish(
        ALICE,
        shader.id,
        terms({ expectedRevision: shader.revision }),
      );
      expect(again.publication.id).toBe(id);
      expect(await publicReads(id)).toEqual(ALL_OK);
    });

    it('lets no owner action undo a moderator’s hide, and no restore undo an unpublish', async () => {
      const { shader, id } = await published();
      const hide = await pubs.moderate(ADMIN, id, {
        hidden: true,
        reason: 'Reported',
        expectedModerationRevision: 1,
      });
      expect(hide).toMatchObject({ moderatorHidden: true, moderationRevision: 2 });
      expect(await publicReads(id)).toEqual(ALL_GONE);
      // The moderator can still inspect it.
      expect((await pubs.adminRead(id)).shader.id).toBe(id);
      expect((await pubs.adminAsset(id, 'texture:1')).bytes).toEqual(PNG);

      const republish = () =>
        pubs.publish(ALICE, shader.id, terms({ expectedRevision: shader.revision }));
      expect((await republish()).publication).toMatchObject({ id, moderatorHidden: true });
      await pubs.unpublish(ALICE, shader.id);
      await republish();
      expect(await publicReads(id)).toEqual(ALL_GONE);

      await pubs.unpublish(ALICE, shader.id);
      await pubs.moderate(ADMIN, id, {
        hidden: false,
        reason: 'Cleared',
        expectedModerationRevision: 2,
      });
      expect(await publicReads(id)).toEqual(ALL_GONE);
      await republish();
      expect(await publicReads(id)).toEqual(ALL_OK);
    });

    it('removes every public trace when the source or the account is deleted', async () => {
      const first = await published('First');
      const second = await published('Second');
      await pubs.report(BOB, second.id, { reason: 'spam' });

      await alice.remove(first.shader.id);
      expect(await publicReads(first.id)).toEqual([...ALL_GONE.slice(0, 5), 'ok']);
      expect(await code(pubs.adminRead(first.id))).toBe('not_found');
      expect(await code(pubs.adminAsset(first.id, 'thumbnail'))).toBe('not_found');

      await pubs.setRestriction(ADMIN, ALICE, {
        restricted: true,
        reason: 'Spam',
        expectedRevision: 0,
      });
      await harness.removeUser(ALICE);
      expect(await publicReads(second.id)).toEqual(ALL_GONE);
      expect((await pubs.adminList({})).publications).toEqual([]);
      expect((await pubs.listReports({ status: 'all' })).reports).toEqual([]);
      expect(await code(pubs.restriction(ALICE))).toBe('not_found');
      // The trail of what was done outlives what it was done to.
      expect((await pubs.listAudit({})).entries.map((entry) => entry.action)).toEqual([
        'publisher.restrict',
      ]);
    });

    it('lists visible publications newest first, in stable pages, searchable by title', async () => {
      const ids: string[] = [];
      for (const name of ['Alpha 100%', 'Beta_fog', 'Gamma', 'Delta', 'Alpha two']) {
        ids.push((await published(name)).id);
        // The listing orders by publish time; keep the five apart on a fast engine.
        await new Promise((resolve) => setTimeout(resolve, 3));
      }
      await pubs.moderate(ADMIN, ids[3], {
        hidden: true,
        reason: 'No',
        expectedModerationRevision: 1,
      });

      const seen: string[] = [];
      let cursor: string | null | undefined;
      do {
        const page = await pubs.listPublic({ limit: '2', ...(cursor ? { cursor } : {}) });
        expect(page.publications.length).toBeLessThanOrEqual(2);
        seen.push(...page.publications.map((entry) => entry.title));
        cursor = page.nextCursor;
      } while (cursor);
      expect(seen).toEqual(['Alpha two', 'Gamma', 'Beta_fog', 'Alpha 100%']);

      const titles = async (search: string) =>
        (await pubs.listPublic({ search })).publications.map((entry) => entry.title);
      expect(await titles('alpha')).toEqual(['Alpha two', 'Alpha 100%']);
      // LIKE wildcards in the term are literal.
      expect(await titles('%')).toEqual(['Alpha 100%']);
      expect(await titles('a_f')).toEqual(['Beta_fog']);
      expect(await code(pubs.listPublic({ limit: '0' }))).toBe('invalid');
      expect(await code(pubs.listPublic({ cursor: 'garbage' }))).toBe('invalid');
      expect((await pubs.listPublic({ limit: '9999' })).publications).toHaveLength(4);

      const hidden = await pubs.adminList({ state: 'hidden' });
      expect(hidden.publications.map((entry) => entry.title)).toEqual(['Delta']);
      expect((await pubs.adminList({})).publications).toHaveLength(5);
    });

    // --- AC-P2-SEARCH / AC-P2-SORT / AC-P2-CURSOR -----------------------------

    describe('public search and sort', () => {
      const at = (second: number) => `2020-01-01T00:00:${String(second).padStart(2, '0')}.000Z`;
      /** title, description, author label, first published, last updated (seconds). */
      const FIXTURE = [
        ['Ember', 'A warm glow', 'Alice A.', 1, 9],
        ['Frost', 'Cold, 50%_off', 'Zed', 2, 5],
        ['Moss', 'Green', 'Alice A.', 3, 5],
        ['Tide', 'Waves', 'Zed', 3, 7],
        ['Hidden glow', 'Glow', 'Zed', 8, 10],
        ['Gone glow', 'Glow', 'Zed', 6, 6],
      ] as const;
      let id: Record<string, string>;

      beforeEach(async () => {
        id = {};
        for (const [title, description, authorLabel, published, updated] of FIXTURE) {
          const shader = await alice.create({ name: title, description });
          const { publication } = await pubs.publish(
            ALICE,
            shader.id,
            terms({ expectedRevision: shader.revision, authorLabel }),
          );
          id[title] = publication.id;
          await harness.stamp(publication.id, at(published), at(updated));
        }
        await pubs.moderate(ADMIN, id['Hidden glow'], {
          hidden: true,
          reason: 'No',
          expectedModerationRevision: 1,
        });
        await pubs.unpublish(ALICE, 'gone-glow');
      });

      /** Tied times fall back to the id, descending. */
      const byId = (...titles: string[]) => titles.sort((a, b) => (id[a] < id[b] ? 1 : -1));
      const updatedOrder = () => ['Ember', 'Tide', ...byId('Frost', 'Moss')];
      const publishedOrder = () => [...byId('Moss', 'Tide'), 'Frost', 'Ember'];

      async function walk(query: Record<string, unknown>, limit: number): Promise<string[]> {
        const seen: string[] = [];
        let cursor: string | null = null;
        do {
          const page: PublicationPage = await pubs.listPublic({
            ...query,
            limit: String(limit),
            ...(cursor ? { cursor } : {}),
          });
          seen.push(...page.publications.map((entry) => entry.title));
          cursor = page.nextCursor;
        } while (cursor);
        return seen;
      }

      it('pages each order completely, ties included, defaulting to last update', async () => {
        for (const limit of [1, 2, 3, 50]) {
          expect(await walk({}, limit)).toEqual(updatedOrder());
          expect(await walk({ sort: 'updated' }, limit)).toEqual(updatedOrder());
          expect(await walk({ sort: 'published' }, limit)).toEqual(publishedOrder());
        }
        const [first] = (await pubs.listPublic({ sort: 'published', limit: '1' })).publications;
        expect(first.publishedAt).toBe(at(3));
        expect(first.updatedAt).toBe(at(first.title === 'Moss' ? 5 : 7));
        expect(await code(pubs.listPublic({ sort: 'oldest' }))).toBe('invalid');
        expect(await code(pubs.listPublic({ sort: ['updated', 'published'] }))).toBe('invalid');
        expect(await code(pubs.listPublic({ sort: '' }))).toBe('invalid');
      });

      it('keeps the first-publication time through update, unpublish and republish', async () => {
        const { revision } = await alice.update('ember', { name: 'Ember II' });
        await pubs.publish(ALICE, 'ember', terms({ expectedRevision: revision }));
        await pubs.unpublish(ALICE, 'ember');
        await pubs.publish(ALICE, 'ember', terms({ expectedRevision: revision }));

        expect((await walk({}, 2))[0]).toBe('Ember II');
        expect(await walk({ sort: 'published' }, 2)).toEqual([
          ...publishedOrder().slice(0, -1),
          'Ember II',
        ]);
        expect((await pubs.readPublic(id['Ember'])).publishedAt).toBe(at(1));
      });

      it('searches title, description and author label of visible snapshots only', async () => {
        const titles = async (search: string, sort = 'updated') =>
          (await pubs.listPublic({ search, sort })).publications.map((entry) => entry.title);
        expect(await titles('glow')).toEqual(['Ember']);
        expect(await titles('ZED')).toEqual(['Tide', 'Frost']);
        expect(await titles('zed', 'published')).toEqual(['Tide', 'Frost']);
        expect(await titles('moss')).toEqual(['Moss']);
        // LIKE wildcards and the escape character are literal.
        expect(await titles('50%_')).toEqual(['Frost']);
        expect(await titles('%')).toEqual(['Frost']);
        expect(await titles('!')).toEqual([]);
        expect(await titles('o_d')).toEqual([]);
        // Only the published snapshot is searched: not a hidden one, nor a later private edit.
        expect(await titles('hidden')).toEqual([]);
        await alice.update('moss', { description: 'Secret draft' });
        expect(await titles('secret')).toEqual([]);
        expect(await walk({ search: 'a.' }, 1)).toEqual(['Ember', 'Moss']);

        // The moderators' search stays on titles, across every state.
        const admin = async (search: string) =>
          (await pubs.adminList({ search })).publications.map((entry) => entry.title).sort();
        expect(await admin('glow')).toEqual(['Gone glow', 'Hidden glow']);
        expect(await admin('zed')).toEqual([]);
      });

      it('binds new cursors to their sort and search, and takes old ones in updated order', async () => {
        const page = await pubs.listPublic({ search: ' ZED ', limit: '1' });
        const cursor = page.nextCursor!;
        expect(JSON.parse(Buffer.from(cursor, 'base64url').toString())).toEqual({
          v: 2,
          sort: 'updated',
          search: 'zed',
          at: at(7),
          id: id['Tide'],
        });
        const next = (query: Record<string, unknown>) =>
          code(pubs.listPublic({ limit: '1', cursor, ...query }));
        expect(await next({ search: 'Zed' })).toBe('ok');
        expect(await next({ search: 'zed', sort: 'published' })).toBe('invalid');
        expect(await next({ search: 'ze' })).toBe('invalid');
        expect(await next({})).toBe('invalid');

        const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
        // A cursor from before sorting existed: no version, no search, updated order only.
        const legacy = encode({ at: at(7), id: id['Tide'] });
        const after = await pubs.listPublic({ cursor: legacy });
        expect(after.publications.map((entry) => entry.title)).toEqual(updatedOrder().slice(2));
        expect(await code(pubs.listPublic({ cursor: legacy, search: 'zed' }))).toBe('ok');
        expect(await code(pubs.listPublic({ cursor: legacy, sort: 'published' }))).toBe('invalid');

        const good = { v: 2, sort: 'updated', search: '', at: at(7), id: id['Tide'] };
        expect(await code(pubs.listPublic({ cursor: encode(good) }))).toBe('ok');
        const forged: unknown[] = [
          { ...good, v: 1 },
          { ...good, v: 3 },
          { ...good, v: '2' },
          { ...good, sort: 'oldest' },
          { ...good, search: 1 },
          { ...good, at: '2020-01-01' },
          { ...good, at: '2020-13-45T00:00:00.000Z' },
          { ...good, at: 7 },
          { ...good, id: 'not-an-id' },
          { ...good, id: "' OR 1=1 --" },
          { ...good, extra: true },
          { at: at(7), id: id['Tide'], extra: true },
          [at(7), id['Tide']],
          null,
          'text',
        ];
        for (const bad of forged) {
          const outcome = await code(pubs.listPublic({ cursor: encode(bad) }));
          expect(`${JSON.stringify(bad)}: ${outcome}`).toBe(`${JSON.stringify(bad)}: invalid`);
        }
        for (const raw of ['%7B', 'a b', 'x'.repeat(1025), ['a', 'b'], 42]) {
          expect(await code(pubs.listPublic({ cursor: raw }))).toBe('invalid');
        }

        // The moderators' cursors are unchanged: plain `{ at, id }`, read as before.
        const adminCursor = (await pubs.adminList({ limit: '1' })).nextCursor!;
        expect(JSON.parse(Buffer.from(adminCursor, 'base64url').toString())).toEqual({
          at: expect.any(String),
          id: expect.any(String),
        });
        expect(
          (await pubs.adminList({ limit: '1', cursor: adminCursor })).publications,
        ).toHaveLength(1);
        expect((await pubs.listReports({ status: 'all', cursor: legacy })).reports).toEqual([]);
        expect((await pubs.listAudit({ cursor: legacy })).entries).toEqual([]);
      });
    });
    // --- copy ----------------------------------------------------------------

    it('copies a snapshot into a private library with fidelity and credit', async () => {
      const { id } = await published();
      const taken = await bob.create({ name: 'Aurora' });

      const copy = await pubs.copy(BOB, id);
      expect(copy.id).not.toBe(taken.id);
      expect(copy).toMatchObject({ name: 'Aurora', author: 'Alice A.', revision: 1 });
      expect(copy.presets.map((preset) => preset.name)).toEqual(['Warm']);
      expect((await bob.readTexture(copy.id, 1))?.bytes).toEqual(PNG);
      expect((await bob.readThumbnail(copy.id))?.bytes).toEqual(PNG);
      // It is Bob's alone, and Alice's publication is untouched by his edits.
      expect(await code(alice.read(copy.id))).toBe('not_found');
      await bob.update(copy.id, { name: 'Mine now' });
      expect((await pubs.readPublic(id)).title).toBe('Aurora');

      const status = await pubs.status(BOB, copy.id);
      expect(status).toMatchObject({
        publication: null,
        restricted: false,
        origin: { publicationId: id, authorLabel: 'Alice A.', license: 'CC-BY-4.0' },
      });
      const { revision } = await bob.read(copy.id);
      const derived = await pubs.publish(
        BOB,
        copy.id,
        terms({ expectedRevision: revision, authorLabel: 'Bob' }),
      );
      expect(derived.publication.derivedFrom).toMatchObject({ publicationId: id, title: 'Aurora' });
      expect(await code(pubs.status(BOB, (await textured('Private')).id))).toBe('not_found');
    });

    it('keeps a share-alike license on anything derived from it', async () => {
      const shader = await textured();
      const { publication } = await pubs.publish(
        ALICE,
        shader.id,
        terms({ expectedRevision: shader.revision, license: 'CC-BY-SA-4.0' }),
      );
      const copy = await pubs.copy(BOB, publication.id);
      const publish = (license: string) =>
        code(pubs.publish(BOB, copy.id, terms({ expectedRevision: copy.revision, license })));

      expect(await publish('MIT')).toBe('invalid');
      expect(await publish('CC-BY-SA-4.0')).toBe('ok');
    });

    // --- AC-MODERATION -------------------------------------------------------

    it('moderates under a revision and audits only what was written', async () => {
      const { id } = await published();
      const moderate = (input: Record<string, unknown>) => code(pubs.moderate(ADMIN, id, input));

      expect(await moderate({ hidden: true, reason: ' ', expectedModerationRevision: 1 })).toBe(
        'invalid',
      );
      expect(await moderate({ hidden: true, reason: 'x', expectedModerationRevision: 7 })).toBe(
        'conflict',
      );
      expect(
        await code(
          pubs.moderate(ADMIN, 'f'.repeat(20), {
            hidden: true,
            reason: 'x',
            expectedModerationRevision: 1,
          }),
        ),
      ).toBe('not_found');
      expect((await pubs.listAudit({})).entries).toEqual([]);

      expect(
        await moderate({ hidden: true, reason: 'Stolen', expectedModerationRevision: 1 }),
      ).toBe('ok');
      // Two moderators acting on the same view: the second is told, not obeyed.
      expect(await moderate({ hidden: false, reason: 'Oops', expectedModerationRevision: 1 })).toBe(
        'conflict',
      );
      expect((await pubs.listAudit({ targetId: id })).entries).toMatchObject([
        { actorUserId: ADMIN, action: 'publication.hide', targetId: id, reason: 'Stolen' },
      ]);
    });

    it('takes one open report per reporter and resolves it once', async () => {
      const { id } = await published();
      const report = (
        user: string,
        input: Record<string, unknown> = { reason: 'copyright', body: 'Mine' },
      ) => code(pubs.report(user, id, input));

      expect(await report(BOB, { reason: 'because' })).toBe('invalid');
      expect(await report(BOB, { reason: 'spam', body: 'x'.repeat(1001) })).toBe('invalid');
      expect(await report(BOB)).toBe('ok');
      expect(await report(BOB)).toBe('conflict');
      expect(await report(ADMIN)).toBe('ok');

      const open = await pubs.listReports({});
      expect(open.reports).toHaveLength(2);
      expect((await pubs.adminRead(id)).openReports).toBe(2);
      const mine = open.reports.find((entry) => entry.reporterUserId === BOB)!;
      expect(mine).toMatchObject({ publicationId: id, reason: 'copyright', body: 'Mine' });

      const resolve = (expectedRevision: number) =>
        code(pubs.resolveReport(ADMIN, mine.id, { reason: 'Checked', expectedRevision }));
      expect(await resolve(1)).toBe('ok');
      expect(await resolve(1)).toBe('conflict');
      expect(
        await code(pubs.resolveReport(ADMIN, 'nope', { reason: 'x', expectedRevision: 1 })),
      ).toBe('not_found');
      expect((await pubs.listReports({})).reports).toHaveLength(1);
      expect((await pubs.listReports({ status: 'resolved' })).reports).toMatchObject([
        { id: mine.id, status: 'resolved', resolution: 'Checked', revision: 2 },
      ]);
      // Once resolved, the same person may report again.
      expect(await report(BOB)).toBe('ok');
      expect((await pubs.listReports({ status: 'all', limit: '2' })).nextCursor).not.toBeNull();
    });

    it('restricts a publisher without touching their private library', async () => {
      const { shader, id } = await published();
      const restrict = (restricted: boolean, expectedRevision: number) =>
        code(pubs.setRestriction(ADMIN, ALICE, { restricted, reason: 'Abuse', expectedRevision }));

      expect(await pubs.restriction(ALICE)).toMatchObject({ restricted: false, revision: 0 });
      expect(await code(pubs.restriction('nobody'))).toBe('not_found');
      expect(await restrict(true, 3)).toBe('conflict');
      expect(await restrict(true, 0)).toBe('ok');
      expect(await restrict(true, 0)).toBe('conflict');

      expect(await publicReads(id)).toEqual(ALL_GONE);
      expect((await pubs.status(ALICE, shader.id)).restricted).toBe(true);
      const publish = async () =>
        code(
          pubs.publish(
            ALICE,
            shader.id,
            terms({ expectedRevision: (await alice.read(shader.id)).revision }),
          ),
        );
      expect(await publish()).toBe('forbidden');
      // Private work carries on.
      expect((await alice.update(shader.id, { name: 'Still mine' })).name).toBe('Still mine');
      expect((await alice.create({ name: 'New private' })).id).toBe('new-private');

      // Nothing of a restricted publisher's can be put back on Explore.
      const hidden = await pubs.adminRead(id);
      const restore = () =>
        code(
          pubs.moderate(ADMIN, id, {
            hidden: false,
            reason: 'Too early',
            expectedModerationRevision: hidden.moderationRevision,
          }),
        );
      expect(await restore()).toBe('invalid');
      expect(await publicReads(id)).toEqual(ALL_GONE);
      expect((await pubs.adminRead(id)).moderationRevision).toBe(hidden.moderationRevision);
      expect((await pubs.listAudit({ targetId: id })).entries).toEqual([]);

      expect(await restrict(false, 1)).toBe('ok');
      // Lifting it restores nothing by itself…
      expect(await publicReads(id)).toEqual(ALL_GONE);
      expect(await publish()).toBe('ok');
      expect(await publicReads(id)).toEqual(ALL_GONE);
      // …a moderator restores each publication deliberately.
      const { moderationRevision } = await pubs.adminRead(id);
      await pubs.moderate(ADMIN, id, {
        hidden: false,
        reason: 'Reviewed',
        expectedModerationRevision: moderationRevision,
      });
      expect(await publicReads(id)).toEqual(ALL_OK);
      expect((await pubs.listAudit({})).entries.map((entry) => entry.action).sort()).toEqual([
        'publication.restore',
        'publisher.restrict',
        'publisher.unrestrict',
      ]);
    });
  });
}
