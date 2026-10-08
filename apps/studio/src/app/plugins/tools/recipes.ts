/**
 * Project Recipes: new shaders started from the active `projectTemplate`
 * contributions (`PluginTools.templates`).
 *
 * A recipe is data. Creating from one copies the template with fresh pass, file
 * and effect identities (`PluginTools.instantiate`), wraps the copy in a shader
 * bundle that goes through the same validation an imported `.shader.json` does,
 * and adopts it in one library import — after the usual unsaved-changes
 * question, and only if the recipe's package is still the one it was taken
 * from once that is answered. The open shader is not touched until then, and a
 * declined question creates nothing. The created shader owns its sources,
 * controls and settings: updating or removing the pack changes nothing in it.
 *
 * What is offered follows the active contributions: switching a pack off,
 * updating or removing it, or changing account empties the list, the commands
 * and the gallery at once. Nothing here names a package.
 */
import { Injectable, Injector, computed, inject, linkedSignal, signal } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';

import type { ShaderBundle, ShaderPayload } from '@shadergrove/shared/model';
import type {
  ProjectTemplateContribution,
  ProjectTemplatePayload,
} from '@shadergrove/shared/plugin';
import { newId } from '@shadergrove/shared/project';
import {
  buildShaderBundle,
  fail,
  ok,
  parseBundle,
  slugify,
  type Result,
} from '@shadergrove/shared/validate';
import { I18n, type TranslationParams } from '../../i18n/i18n';
import type { TranslationKey } from '../../i18n/keys';
import type { MenuCommand } from '../../ui/menu-commands';
import { WorkspaceActions } from '../../ui/workspace-actions';
import { ShaderStore } from '../../workspace/shader-store';
import { PluginInstallations } from '../plugin-installations';
import { PluginTools, type ActiveTemplate } from '../plugin-tools';

const GALLERY_DIALOG_ID = 'recipe-gallery';

/**
 * The English of the `recipes.*` keys. ponytail: the shared dictionaries are the
 * coordinator's; until they carry these keys (02-coordinator-fragments.md) this
 * is what they read. Delete it and call `i18n.t` once they do.
 */
const RECIPE_TEXT = {
  'recipes.command': 'New from a recipe…',
  'recipes.title': 'New from a recipe',
  'recipes.intro':
    'A recipe creates a new shader of your own. Its passes, files and controls are copied, and stay yours whatever happens to the recipe pack.',
  'recipes.empty': 'No recipe is available. Switch a recipe pack on under Plugins.',
  'recipes.beginner': 'Beginner',
  'recipes.intermediate': 'Intermediate',
  'recipes.advanced': 'Advanced',
  'recipes.source': 'From {package} · by {author} · {license}',
  'recipes.controls': 'Controls: {list}',
  'recipes.preview': 'Preview',
  'recipes.stopPreview': 'Stop preview',
  'recipes.created': 'Created “{name}” from a recipe.',
  'recipes.cancelled': 'Nothing was created.',
  'recipes.failed': 'The shader could not be created.',
} as const;

export type RecipeTextKey = keyof typeof RECIPE_TEXT;

export type RecipeOutcome =
  | { status: 'created'; name: string }
  /** The unsaved-changes question was declined, or another transition was under way. */
  | { status: 'cancelled' }
  /** The pack was switched off, updated or removed, or the account changed. */
  | { status: 'stale' }
  | { status: 'failed'; message: string };

/**
 * A recipe copy as a shader bundle, validated as an imported one is. The
 * copy's own identities are kept: the library gives the shader a free id.
 */
export function recipeBundle(
  payload: ProjectTemplatePayload,
  contribution: ProjectTemplateContribution,
  name: string,
): Result<ShaderBundle> {
  const shader: ShaderPayload = {
    id: slugify(name) || newId('recipe'),
    name,
    description: contribution.description,
    controls: payload.controls,
    render: payload.render,
    fragment: payload.project.passes.find((pass) => pass.kind === 'image')?.source ?? '',
    vertex: payload.project.vertex,
    presets: payload.presets,
    // Four empty slots once validated: a recipe binds no texture.
    channels: [] as unknown as ShaderPayload['channels'],
    thumbnail: null,
    project: payload.project,
  };
  const parsed = parseBundle(buildShaderBundle(shader));
  if (!parsed.ok) return fail(...parsed.errors);
  return ok(buildShaderBundle(parsed.value[0]!) as ShaderBundle);
}

@Injectable({ providedIn: 'root' })
export class ProjectRecipes {
  private readonly tools = inject(PluginTools);
  private readonly installations = inject(PluginInstallations);
  private readonly store = inject(ShaderStore);
  private readonly i18n = inject(I18n);
  private readonly dialog = inject(MatDialog);
  // Resolved on use: the workspace opens the New dialog, which offers recipes in turn.
  private readonly injector = inject(Injector);

  /** Every active recipe, in package then manifest order. */
  readonly recipes = this.tools.templates;

  /** The recipe whose live preview is running, by ref: one at a time, app-wide. */
  readonly previewing = linkedSignal<readonly ActiveTemplate[], string | null>({
    source: this.recipes,
    // A recipe that stops being offered stops previewing, and does not resume when it returns.
    computation: (recipes, previous) =>
      previous && recipes.some((recipe) => recipe.ref === previous.value) ? previous.value : null,
  });

  /** A creation is under way, from the click until it is adopted or dropped. */
  readonly creating = signal(false);

  /**
   * "New from a recipe…", while any recipe is active: for the New shader dialog,
   * the menus and the palette, as the importers' commands are.
   */
  readonly commands = computed<readonly MenuCommand[]>(() =>
    this.recipes().length === 0
      ? []
      : [
          {
            id: 'recipes:new',
            icon: () => 'auto_stories',
            label: () => this.text('recipes.command'),
            action: () => void this.openGallery(),
          },
        ],
  );

  find(packageId: string, contributionId: string): ActiveTemplate | null {
    return (
      this.recipes().find(
        (recipe) => recipe.installed.id === packageId && recipe.contribution.id === contributionId,
      ) ?? null
    );
  }

  /** The recipe's name, made distinct from the shaders already in the library. */
  defaultName(recipe: ActiveTemplate): string {
    const taken = new Set(this.store.shaders().map((shader) => shader.name));
    const base = recipe.contribution.name;
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base} ${n}`;
    return name;
  }

  /** Opens the gallery of every active recipe; one at a time. */
  async openGallery(): Promise<void> {
    if (this.dialog.getDialogById(GALLERY_DIALOG_ID)) return;
    const { RecipeGalleryDialog } = await import('./recipes-panel');
    if (this.dialog.getDialogById(GALLERY_DIALOG_ID) || this.recipes().length === 0) return;
    this.dialog.open(RecipeGalleryDialog, {
      id: GALLERY_DIALOG_ID,
      width: '760px',
      maxWidth: '92vw',
      autoFocus: 'dialog',
    });
  }

  /**
   * Creates a shader named `name` from a recipe and opens it. The pack's
   * installation is captured now and checked again once the unsaved-changes
   * question is answered, right before the import: if it changed, nothing is
   * created.
   */
  async create(packageId: string, contributionId: string, name: string): Promise<RecipeOutcome> {
    if (this.creating()) return { status: 'cancelled' };
    const context = this.installations.context(packageId);
    const recipe = this.find(packageId, contributionId);
    const copy =
      context && recipe ? this.tools.instantiate(packageId, contributionId, context) : null;
    if (!context || !recipe || !copy) return { status: 'stale' };
    const bundle = recipeBundle(copy, recipe.contribution, name.trim());
    if (!bundle.ok) return { status: 'failed', message: bundle.errors[0] ?? '' };

    this.creating.set(true);
    let outcome: RecipeOutcome = { status: 'cancelled' };
    try {
      const went = await this.injector.get(WorkspaceActions).guardedTransition(async () => {
        if (!this.installations.isCurrent(context)) {
          outcome = { status: 'stale' };
          return;
        }
        const notice = this.text('recipes.created', { name: bundle.value.shader.name });
        outcome = (await this.store.importProjectBundle(bundle.value, notice))
          ? { status: 'created', name: bundle.value.shader.name }
          : { status: 'failed', message: this.text('recipes.failed') };
      });
      return went ? outcome : { status: 'cancelled' };
    } finally {
      this.creating.set(false);
    }
  }

  /** A `recipes.*` message in the language worn. */
  text(key: RecipeTextKey, params: TranslationParams = {}): string {
    const translated = this.i18n.t(key as string as TranslationKey, params);
    if (translated !== key) return translated;
    return RECIPE_TEXT[key].replace(/\{(\w+)\}/g, (placeholder, field: string) =>
      Object.hasOwn(params, field) ? String(params[field]) : placeholder,
    );
  }
}
