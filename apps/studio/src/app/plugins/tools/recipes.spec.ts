import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_RENDER, type ShaderBundle } from '@shadergrove/shared/model';
import {
  instantiateProjectTemplate,
  isDataOnlyPackage,
  parsePluginPackage,
  type PluginPackage,
  type ProjectTemplateContribution,
  type ProjectTemplatePayload,
} from '@shadergrove/shared/plugin';
import { composePass, migrateLegacyProject, type ShaderProject } from '@shadergrove/shared/project';
import { parseBundle } from '@shadergrove/shared/validate';
import { AuthService } from '../../auth/auth.service';
import { DesktopPlatform } from '../../desktop/desktop-platform';
import { Preferences } from '../../prefs/preferences';
import { WorkspaceActions } from '../../ui/workspace-actions';
import { ShaderStore } from '../../workspace/shader-store';
import { PLUGIN_STORE, PluginInstallations } from '../plugin-installations';
import type { StoredPlugin } from '../plugin-store';
import { GlContextRegistry } from '../../rendering/gl-context-registry';
import { RecipeCard, RecipeGalleryDialog } from './recipes-panel';
import { ProjectRecipes, recipeBundle } from './recipes';

/**
 * AC-RECIPES and AC-LIFECYCLE for the Project Recipes pack: the official package
 * as the generator writes it, independent copies with their graph intact, and
 * creation through the real installations and templates — atomic behind the
 * unsaved-changes question, refused once the pack changed, and never tied to
 * the pack afterwards.
 */
const PACK = 'dev.shadergrove.project-recipes';
const generated = resolve(import.meta.dirname, '../../../plugins');
const packText = readFileSync(
  resolve(generated, readdirSync(generated).find((file) => file.startsWith(`${PACK}-`))!),
  'utf8',
);

function pack(): PluginPackage {
  const parsed = parsePluginPackage(packText);
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  return parsed.value;
}

const recipesOf = (plugin: PluginPackage) =>
  plugin.manifest.contributions.filter(
    (contribution): contribution is ProjectTemplateContribution =>
      contribution.kind === 'projectTemplate',
  );

/** Pass, file and effect ids replaced by their position: the graph without its identities. */
function shape(payload: ProjectTemplatePayload): unknown {
  const passIndex = new Map(payload.project.passes.map((pass, index) => [pass.id, index]));
  return {
    ...payload,
    project: {
      ...payload.project,
      passes: payload.project.passes.map((pass) => ({
        ...pass,
        id: passIndex.get(pass.id),
        channels: pass.channels.map((binding) =>
          binding.kind === 'buffer'
            ? { ...binding, passId: passIndex.get(binding.passId) }
            : binding,
        ),
      })),
      files: payload.project.files.map(({ id: _id, ...file }) => file),
    },
    render: {
      postProcessing: {
        ...payload.render.postProcessing,
        effects: payload.render.postProcessing.effects.map(
          ({ instanceId: _id, ...effect }) => effect,
        ),
      },
    },
  };
}

/** Every identity a copy holds. */
const identities = (payload: ProjectTemplatePayload): string[] => [
  ...payload.project.passes.map((pass) => pass.id),
  ...payload.project.files.map((file) => file.id),
  ...payload.render.postProcessing.effects.map((effect) => effect.instanceId),
];

/** The package text with its manifest and templates changed by `edit`. */
function edited(
  // Raw package JSON, edited freely to make it malformed.
  // oxlint-disable-next-line no-explicit-any
  edit: (json: { manifest: Record<string, unknown>; templates: Record<string, any> }) => void,
) {
  const json = JSON.parse(packText) as Parameters<typeof edit>[0];
  edit(json);
  return JSON.stringify(json);
}

describe('Project Recipes', () => {
  describe('the official pack', () => {
    it('is a protocol-4, data-only template pack with four recipes', () => {
      const plugin = pack();
      expect(plugin.manifest.protocolVersion).toBe(4);
      expect(plugin.code).toBeUndefined();
      // Not plain data like a theme: satellite and output windows never receive it.
      expect(isDataOnlyPackage(plugin)).toBe(false);
      const recipes = recipesOf(plugin);
      expect(recipes.map((recipe) => recipe.id)).toEqual([
        'raymarching',
        'particles',
        'feedback-trails',
        'interactive-ui',
      ]);
      expect(new Set(recipes.map((recipe) => recipe.difficulty))).toEqual(
        new Set(['beginner', 'intermediate', 'advanced']),
      );
      for (const recipe of recipes) {
        expect(recipe.notes.length).toBeGreaterThan(0);
        expect(recipe.provenance).toEqual({ author: 'Shadergrove', license: 'Apache-2.0' });
      }
    });

    it('binds no texture, composes every pass and declares every control it has', () => {
      const plugin = pack();
      for (const recipe of recipesOf(plugin)) {
        const { project, controls } = plugin.templates[recipe.id]!;
        const sources = project.passes.map((pass) => {
          expect(pass.channels.every((binding) => binding.kind !== 'texture')).toBe(true);
          const composed = composePass(project, pass);
          expect(composed.errors, `${recipe.id}/${pass.name}`).toEqual([]);
          return composed.source;
        });
        expect(controls.length).toBeGreaterThan(0);
        for (const control of controls) {
          expect(
            sources.some((source) => source.includes(`u_${control.key};`)),
            `${recipe.id}: u_${control.key}`,
          ).toBe(true);
        }
      }
    });

    it('wires the feedback recipes as a buffer reading itself and an Image reading the buffer', () => {
      const plugin = pack();
      for (const id of ['feedback-trails', 'interactive-ui']) {
        const { passes } = plugin.templates[id]!.project;
        const buffer = passes.find((pass) => pass.kind === 'buffer')!;
        const image = passes.find((pass) => pass.kind === 'image')!;
        expect(buffer.channels[0]).toEqual({ kind: 'buffer', passId: buffer.id, feedback: true });
        expect(image.channels[0]).toEqual({ kind: 'buffer', passId: buffer.id, feedback: false });
        // First frames: an unwritten texel (alpha 0) starts the state or the trail clean.
        expect(buffer.source).toContain('.a < 0.5');
      }
      expect(plugin.templates['raymarching']!.project.files.map((file) => file.name)).toEqual([
        'sdf.glsl',
      ]);
    });
  });

  describe('copies', () => {
    it('gives every copy fresh identities and keeps the graph, defaults and settings', () => {
      const plugin = pack();
      for (const recipe of recipesOf(plugin)) {
        const template = plugin.templates[recipe.id]!;
        const first = instantiateProjectTemplate(template);
        const second = instantiateProjectTemplate(template);
        const firstIds = identities(first);
        const secondIds = identities(second);
        expect(new Set([...firstIds, ...secondIds]).size).toBe(firstIds.length * 2);
        for (const id of identities(template)) expect(firstIds).not.toContain(id);
        expect(shape(first)).toEqual(shape(template));
        expect(shape(second)).toEqual(shape(template));
      }
    });

    it('makes a bundle that validates and survives a save/export round trip unchanged', () => {
      const plugin = pack();
      for (const recipe of recipesOf(plugin)) {
        const copy = instantiateProjectTemplate(plugin.templates[recipe.id]!);
        const bundle = recipeBundle(copy, recipe, 'My recipe');
        if (!bundle.ok) throw new Error(bundle.errors.join());
        const { shader } = bundle.value;
        expect(shader.name).toBe('My recipe');
        expect(shader.project).toEqual(copy.project);
        expect(shader.controls).toEqual(copy.controls);
        expect(shader.render).toEqual(copy.render);
        expect(shader.channels.every((channel) => channel.data === null)).toBe(true);
        // What an exported bundle reads back as.
        const again = parseBundle(JSON.parse(JSON.stringify(bundle.value)));
        if (!again.ok) throw new Error(again.errors.join());
        expect(again.value[0]!.project).toEqual(shader.project);
      }
    });

    it('refuses a name a shader cannot have', () => {
      const plugin = pack();
      const [recipe] = recipesOf(plugin);
      const copy = instantiateProjectTemplate(plugin.templates[recipe!.id]!);
      expect(recipeBundle(copy, recipe!, '').ok).toBe(false);
      expect(recipeBundle(copy, recipe!, 'x'.repeat(500)).ok).toBe(false);
    });
  });

  describe('malformed and unsupported templates', () => {
    const refused = (text: string) => {
      const parsed = parsePluginPackage(text);
      expect(parsed.ok).toBe(false);
      return parsed.ok ? '' : parsed.errors.join('; ');
    };

    it('refuses texture bindings, dangling buffers, extra fields and missing data', () => {
      expect(
        refused(
          edited((json) => {
            json.templates['particles'].project.passes[0].channels[1] = {
              kind: 'texture',
              slot: 0,
            };
          }),
        ),
      ).toContain('texture');
      expect(
        refused(
          edited((json) => {
            json.templates['feedback-trails'].project.passes[1].channels[0].passId = 'gone';
          }),
        ),
      ).toContain('does not exist');
      expect(
        refused(
          edited((json) => {
            json.templates['particles'].generator = 'return project';
          }),
        ),
      ).toContain('generator');
      expect(
        refused(
          edited((json) => {
            delete json.templates['interactive-ui'];
          }),
        ),
      ).toContain('interactive-ui');
    });

    it('refuses templates under an older protocol and an unknown one', () => {
      expect(refused(edited((json) => (json.manifest['protocolVersion'] = 3)))).not.toBe('');
      expect(refused(edited((json) => (json.manifest['protocolVersion'] = 5)))).not.toBe('');
    });
  });

  describe('creating', () => {
    const user = signal<{ id: string } | null>(null);
    const status = signal<'loading' | 'anonymous' | 'authenticated'>('anonymous');
    const shaders = signal<{ id: string; name: string }[]>([]);
    const importProjectBundle = vi.fn(async (_bundle: unknown, _notice: string) => true);
    /** The unsaved-changes question: `answer` decides it, after `before` ran. */
    let answer: () => Promise<boolean>;
    let profiles: Map<string, Map<string, StoredPlugin>>;
    const close = vi.fn();

    function setup() {
      TestBed.configureTestingModule({
        providers: [
          provideZonelessChangeDetection(),
          {
            provide: PLUGIN_STORE,
            useValue: (profile: string) => {
              const records = profiles.get(profile) ?? new Map<string, StoredPlugin>();
              profiles.set(profile, records);
              return {
                list: async () => [...records.values()],
                put: async (stored: StoredPlugin) => void records.set(stored.id, stored),
                remove: async (id: string) => void records.delete(id),
                replace: async (stored: StoredPlugin) =>
                  records.get(stored.id)?.installedAt === stored.installedAt
                    ? (records.set(stored.id, stored), true)
                    : false,
                readBootstrap: async () => null,
                writeBootstrap: async () => undefined,
              };
            },
          },
          { provide: AuthService, useValue: { user, status } },
          { provide: DesktopPlatform, useValue: { available: false } },
          // The real I18n, speaking the bundled English: the text a user reads.
          {
            provide: Preferences,
            useValue: { value: signal({ language: 'en' }).asReadonly(), patch: vi.fn() },
          },
          {
            provide: WorkspaceActions,
            useValue: {
              guardedTransition: async (action: () => Promise<void>) => {
                if (!(await answer())) return false;
                await action();
                return true;
              },
            },
          },
          {
            provide: ShaderStore,
            useValue: {
              selectedId: signal('waves'),
              draft: signal({
                project: migrateLegacyProject('void main() {}', 'void main() {}'),
                render: DEFAULT_RENDER,
              }),
              controls: signal([]),
              params: signal({}),
              shaders,
              importProjectBundle,
            },
          },
          { provide: MatDialog, useValue: { getDialogById: () => undefined, open: vi.fn() } },
          { provide: MatDialogRef, useValue: { close } },
          // No WebGL here: a preview reports that it cannot run, as on such a device.
          {
            provide: GlContextRegistry,
            useValue: { create: async () => Promise.reject(new Error('no WebGL')) },
          },
        ],
      });
      return {
        recipes: TestBed.inject(ProjectRecipes),
        installations: TestBed.inject(PluginInstallations),
      };
    }

    async function settle(): Promise<void> {
      TestBed.tick();
      for (let i = 0; i < 6; i++) await Promise.resolve();
    }

    async function install(installations: PluginInstallations, enable = true): Promise<void> {
      await settle();
      const review = installations.review(new TextEncoder().encode(packText));
      if (!review.ok) throw new Error(review.errors.join());
      await installations.install(review);
      if (enable) await installations.setEnabled(PACK, true);
      await settle();
    }

    const imported = (call = 0) => importProjectBundle.mock.calls[call]![0] as ShaderBundle;

    beforeEach(() => {
      profiles = new Map();
      user.set(null);
      status.set('anonymous');
      shaders.set([]);
      importProjectBundle.mockClear();
      answer = async () => true;
    });

    afterEach(() => TestBed.resetTestingModule());

    it('offers recipes and the New command only while the pack is on, in this profile', async () => {
      const { recipes, installations } = setup();
      await install(installations, false);
      expect(recipes.recipes()).toEqual([]);
      expect(recipes.commands()).toEqual([]);

      await installations.setEnabled(PACK, true);
      await settle();
      expect(recipes.recipes().map((recipe) => recipe.ref)).toEqual([
        `${PACK}/raymarching`,
        `${PACK}/particles`,
        `${PACK}/feedback-trails`,
        `${PACK}/interactive-ui`,
      ]);
      expect(recipes.commands().map((command) => command.label())).toEqual(['New from a recipe…']);

      user.set({ id: 'someone-else' });
      status.set('authenticated');
      await settle();
      expect(recipes.recipes()).toEqual([]);
      expect(recipes.commands()).toEqual([]);
    });

    it('creates two independent shaders from one recipe', async () => {
      const { recipes, installations } = setup();
      await install(installations);

      expect(await recipes.create(PACK, 'feedback-trails', 'Trails one')).toEqual({
        status: 'created',
        name: 'Trails one',
      });
      expect(await recipes.create(PACK, 'feedback-trails', 'Trails two')).toEqual({
        status: 'created',
        name: 'Trails two',
      });
      const [one, two] = [imported(0).shader, imported(1).shader];
      expect(importProjectBundle.mock.calls[0]![1]).toBe('Created “Trails one” from a recipe.');
      const passIds = (project: ShaderProject) => project.passes.map((pass) => pass.id);
      expect(passIds(one.project).filter((id) => passIds(two.project).includes(id))).toEqual([]);
      for (const { project } of [one, two]) {
        const buffer = project.passes.find((pass) => pass.kind === 'buffer')!;
        const image = project.passes.find((pass) => pass.kind === 'image')!;
        expect(buffer.channels[0]).toEqual({ kind: 'buffer', passId: buffer.id, feedback: true });
        expect(image.channels[0]).toEqual({ kind: 'buffer', passId: buffer.id, feedback: false });
      }
    });

    it('creates nothing when the unsaved-changes question is declined', async () => {
      const { recipes, installations } = setup();
      await install(installations);
      answer = async () => false;
      expect(await recipes.create(PACK, 'particles', 'Particles')).toEqual({ status: 'cancelled' });
      expect(importProjectBundle).not.toHaveBeenCalled();
      expect(recipes.creating()).toBe(false);
    });

    it.each([
      [
        'switched off',
        (installations: PluginInstallations) => installations.setEnabled(PACK, false),
      ],
      ['removed', (installations: PluginInstallations) => installations.remove(PACK)],
    ])('creates nothing when the pack is %s while the question is open', async (_, change) => {
      const { recipes, installations } = setup();
      await install(installations);
      answer = async () => {
        await change(installations);
        await settle();
        return true;
      };
      expect(await recipes.create(PACK, 'raymarching', 'Shape')).toEqual({ status: 'stale' });
      expect(importProjectBundle).not.toHaveBeenCalled();
    });

    it('refuses a recipe that is not offered and an invalid name, without asking', async () => {
      const { recipes, installations } = setup();
      await install(installations, false);
      answer = vi.fn(async () => true);
      expect(await recipes.create(PACK, 'raymarching', 'Shape')).toEqual({ status: 'stale' });
      await installations.setEnabled(PACK, true);
      await settle();
      expect((await recipes.create(PACK, 'raymarching', '   ')).status).toBe('failed');
      expect(answer).not.toHaveBeenCalled();
      expect(importProjectBundle).not.toHaveBeenCalled();
    });

    it('owes the pack nothing once created: removing it leaves the bundle as it was', async () => {
      const { recipes, installations } = setup();
      await install(installations);
      await recipes.create(PACK, 'interactive-ui', 'Panel');
      const snapshot = JSON.stringify(imported());
      await installations.remove(PACK);
      await settle();
      expect(recipes.recipes()).toEqual([]);
      expect(JSON.stringify(imported())).toBe(snapshot);
      // The pack's own template was never touched by the copy.
      expect(imported().shader.project.passes.map((pass) => pass.id)).not.toContain('state');
    });

    it('suggests a name the library does not have yet', async () => {
      const { recipes, installations } = setup();
      await install(installations);
      const trails = recipes.find(PACK, 'feedback-trails')!;
      expect(recipes.defaultName(trails)).toBe('Feedback trails');
      shaders.set([
        { id: 'a', name: 'Feedback trails' },
        { id: 'b', name: 'Feedback trails 2' },
      ]);
      expect(recipes.defaultName(trails)).toBe('Feedback trails 3');
    });

    it('draws a card that creates and disappears with its pack', async () => {
      const { recipes, installations } = setup();
      await install(installations);
      const fixture = TestBed.createComponent(RecipeCard);
      fixture.componentRef.setInput('packageId', PACK);
      fixture.componentRef.setInput('contributionId', 'particles');
      const created: string[] = [];
      fixture.componentInstance.created.subscribe((name) => created.push(name));
      await fixture.whenStable();
      const element = fixture.nativeElement as HTMLElement;
      const ref = `${PACK}/particles`;
      const card = element.querySelector(`[data-testid="recipe-${ref}"]`)!;
      expect(card.textContent).toContain('Procedural particles');
      expect(card.textContent).toContain('Beginner');
      expect(card.textContent).toContain('From Project Recipes · by Shadergrove · Apache-2.0');
      expect(
        element.querySelector(`[data-testid="recipe-controls-${ref}"]`)!.textContent,
      ).toContain('Controls: Particles, Size, Speed, Color A, and Color B');
      expect(
        (element.querySelector(`[data-testid="recipe-name-${ref}"]`) as HTMLInputElement).value,
      ).toBe('Procedural particles');

      (element.querySelector(`[data-testid="recipe-create-${ref}"]`) as HTMLButtonElement).click();
      await settle();
      await fixture.whenStable();
      expect(created).toEqual(['Procedural particles']);
      expect(recipes.creating()).toBe(false);

      await installations.setEnabled(PACK, false);
      await settle();
      await fixture.whenStable();
      expect(element.querySelector(`[data-testid="recipe-${ref}"]`)).toBeNull();
    });

    it('keeps a typed name across library refreshes, and suggests a fresh one after creating', async () => {
      const { installations } = setup();
      await install(installations);
      const fixture = TestBed.createComponent(RecipeCard);
      fixture.componentRef.setInput('packageId', PACK);
      fixture.componentRef.setInput('contributionId', 'particles');
      await fixture.whenStable();
      const ref = `${PACK}/particles`;
      const field = () =>
        (fixture.nativeElement as HTMLElement).querySelector(
          `[data-testid="recipe-name-${ref}"]`,
        ) as HTMLInputElement;
      field().value = 'Mine';
      field().dispatchEvent(new Event('input'));
      await fixture.whenStable();
      // Another tab saved something: the list is replaced, the typed name stays.
      shaders.set([{ id: 'a', name: 'Elsewhere' }]);
      await fixture.whenStable();
      expect(field().value).toBe('Mine');

      shaders.set([{ id: 'a', name: 'Procedural particles' }]);
      (
        (fixture.nativeElement as HTMLElement).querySelector(
          `[data-testid="recipe-create-${ref}"]`,
        ) as HTMLButtonElement
      ).click();
      await settle();
      await fixture.whenStable();
      expect(field().value).toBe('Procedural particles 2');
    });

    it('lists every active recipe in the gallery, previews one at a time and closes once one is created', async () => {
      const { recipes, installations } = setup();
      await install(installations);
      close.mockClear();
      const fixture = TestBed.createComponent(RecipeGalleryDialog);
      await fixture.whenStable();
      const element = fixture.nativeElement as HTMLElement;
      const button = (testId: string) =>
        element.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement;
      expect(element.querySelectorAll('app-recipe-card article')).toHaveLength(4);

      button(`recipe-preview-${PACK}/raymarching`).click();
      await fixture.whenStable();
      button(`recipe-preview-${PACK}/particles`).click();
      await fixture.whenStable();
      expect(recipes.previewing()).toBe(`${PACK}/particles`);
      expect(element.querySelectorAll('app-recipe-preview')).toHaveLength(1);
      await vi.waitFor(() =>
        expect(button('recipe-preview-problem').textContent).toContain('WebGL is unavailable'),
      );

      button(`recipe-create-${PACK}/particles`).click();
      await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
      expect(importProjectBundle).toHaveBeenCalledTimes(1);

      await installations.setEnabled(PACK, false);
      await settle();
      await fixture.whenStable();
      expect(element.querySelectorAll('app-recipe-card article')).toHaveLength(0);
      expect(button('recipe-gallery-empty').textContent).toContain('No recipe is available');
      // The preview went with its card.
      expect(recipes.previewing()).toBeNull();
    });
  });
});
