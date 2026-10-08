/**
 * The host's recipe gallery: a card per active recipe (name, difficulty, pack,
 * description, notes, controls), an on-demand live preview, and a name to
 * create a shader under. The pack supplies data only; everything here is the
 * app's. Cards are used in the gallery dialog (`ProjectRecipes.openGallery`)
 * and, one per contribution, in a pack's Installed card.
 */
import {
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';

import type { ProjectTemplatePayload, TemplateDifficulty } from '@shadergrove/shared/plugin';
import { composePass } from '@shadergrove/shared/pass-source';
import { resolvePassOrder } from '@shadergrove/shared/project';
import { LIMITS, defaultParams } from '@shadergrove/shared/validate';
import { I18n } from '../../i18n/i18n';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { GlContextRegistry } from '../../rendering/gl-context-registry';
import { ShaderEngine, type EnginePass } from '../../rendering/shader-engine';
import type { ActiveTemplate } from '../plugin-tools';
import { ProjectRecipes, type RecipeOutcome, type RecipeTextKey } from './recipes';

/**
 * A live render of one recipe's own data, on a WebGL context of its own and
 * only while it is on screen: destroying it frees the context. It never touches
 * `ShaderStore` — previewing creates nothing. What it renders is the pack's
 * validated, texture-free template, nothing typed by anyone.
 */
@Component({
  selector: 'app-recipe-preview',
  template: `
    <canvas #canvas class="canvas" data-testid="recipe-preview-canvas"></canvas>
    @if (problem(); as message) {
      <p class="problem" role="alert" data-testid="recipe-preview-problem">{{ message }}</p>
    }
  `,
  styles: `
    :host {
      position: relative;
      display: block;
      aspect-ratio: 16 / 9;
      max-width: 480px;
      background: #0b0b0c;
    }

    .canvas {
      display: block;
      width: 100%;
      height: 100%;
    }

    .problem {
      position: absolute;
      inset: auto 0 0;
      margin: 0;
      padding: 8px 12px;
      background: color-mix(in srgb, var(--mat-sys-error-container) 92%, transparent);
      color: var(--mat-sys-on-error-container);
      font: var(--mat-sys-body-small);
    }
  `,
})
export class RecipePreview {
  readonly payload = input.required<ProjectTemplatePayload>();

  private readonly contexts = inject(GlContextRegistry);
  private readonly i18n = inject(I18n);
  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  protected readonly problem = signal<string | null>(null);
  private destroyed = false;
  private release: (() => void) | null = null;

  constructor() {
    afterNextRender(() => void this.boot());
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.release?.();
    });
  }

  private async boot(): Promise<void> {
    const canvas = this.canvas().nativeElement;
    let engine: ShaderEngine;
    try {
      engine = await ShaderEngine.create(await this.contexts.create(canvas));
    } catch {
      this.problem.set(this.i18n.t('explore.previewUnavailable'));
      return;
    }
    const observer = new ResizeObserver(() => engine.resize());
    this.release = () => {
      observer.disconnect();
      engine.dispose();
    };
    if (this.destroyed) return this.release();
    engine.onContextLost = () => this.problem.set(this.i18n.t('explore.previewLost'));
    engine.onContextRestored = () => this.problem.set(null);

    const { project, controls, render } = this.payload();
    let failed = false;
    const passes = resolvePassOrder(project).order.map((pass): EnginePass => {
      const { source, spans, errors } = composePass(project, pass);
      failed ||= errors.length > 0;
      return {
        id: pass.id,
        kind: pass.kind === 'image' ? 'image' : 'buffer',
        fragment: source,
        spans,
        channels: pass.channels,
        resolution: pass.resolution,
        filter: pass.filter,
        wrap: pass.wrap,
      };
    });
    const diagnostics = engine.setPasses({
      vertex: project.vertex,
      controls,
      params: defaultParams(controls),
      render,
      passes,
      textures: [null, null, null, null],
    });
    if (failed || diagnostics.some((entry) => entry.severity === 'error')) {
      this.problem.set(this.i18n.t('explore.previewFailed'));
    }
    observer.observe(canvas);
  }
}

type Report = { text: string; error: boolean };

/**
 * One recipe: what it is, an optional preview, and a name to create it under.
 * Shows nothing once the recipe is no longer active. Emits `created` with the
 * new shader's name.
 */
@Component({
  selector: 'app-recipe-card',
  imports: [
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    RecipePreview,
    TranslatePipe,
  ],
  template: `
    @if (recipe(); as entry) {
      <article class="recipe" [attr.data-testid]="'recipe-' + entry.ref">
        <header>
          <h3>{{ entry.contribution.name }}</h3>
          <span class="difficulty" [attr.data-testid]="'recipe-difficulty-' + entry.ref">
            {{ recipes.text(difficulty[entry.contribution.difficulty]) }}
          </span>
        </header>
        <p class="muted">
          {{
            recipes.text('recipes.source', {
              package: entry.installed.plugin?.manifest?.name ?? entry.installed.id,
              author: entry.contribution.provenance.author,
              license: entry.contribution.provenance.license,
            })
          }}
        </p>
        <p>{{ entry.contribution.description }}</p>
        @if (entry.contribution.notes.length > 0) {
          <ul class="notes">
            @for (note of entry.contribution.notes; track $index) {
              <li>{{ note }}</li>
            }
          </ul>
        }
        <p class="muted" [attr.data-testid]="'recipe-controls-' + entry.ref">
          {{ controls() }}
        </p>
        @if (recipes.previewing() === entry.ref) {
          <app-recipe-preview [payload]="entry.payload" />
        }
        <div class="actions">
          <button
            matButton
            type="button"
            [attr.data-testid]="'recipe-preview-' + entry.ref"
            (click)="togglePreview(entry.ref)"
          >
            <mat-icon>{{ recipes.previewing() === entry.ref ? 'stop' : 'play_arrow' }}</mat-icon>
            {{
              recipes.text(recipes.previewing() === entry.ref ? 'recipes.stopPreview' : 'recipes.preview')
            }}
          </button>
          <mat-form-field appearance="outline" class="name" subscriptSizing="dynamic">
            <mat-label>{{ 'dialog.name' | translate }}</mat-label>
            <input
              matInput
              [attr.data-testid]="'recipe-name-' + entry.ref"
              [attr.maxlength]="maxName"
              [disabled]="recipes.creating()"
              [ngModel]="name()"
              (ngModelChange)="name.set($event)"
              (keyup.enter)="create(entry)"
            />
          </mat-form-field>
          <button
            matButton="filled"
            type="button"
            [attr.data-testid]="'recipe-create-' + entry.ref"
            [disabled]="!canCreate()"
            (click)="create(entry)"
          >
            {{ 'action.create' | translate }}
          </button>
        </div>
        @if (report(); as current) {
          <p
            [class.error]="current.error"
            [attr.role]="current.error ? 'alert' : 'status'"
            [attr.data-testid]="'recipe-message-' + entry.ref"
          >
            {{ current.text }}
          </p>
        }
      </article>
    }
  `,
  styles: `
    .recipe {
      display: grid;
      gap: 8px;
      padding: 12px 0;
    }

    header {
      display: flex;
      align-items: baseline;
      gap: 12px;
    }

    h3,
    p {
      margin: 0;
    }

    .difficulty {
      padding: 2px 8px;
      border-radius: 12px;
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
      font: var(--mat-sys-label-small);
    }

    .notes {
      margin: 0;
      padding-left: 18px;
      font: var(--mat-sys-body-small);
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 12px;
    }

    .name {
      flex: 1 1 200px;
    }

    .muted {
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
    }

    .error {
      color: var(--mat-sys-error);
    }
  `,
})
export class RecipeCard {
  readonly packageId = input.required<string>();
  readonly contributionId = input.required<string>();
  readonly created = output<string>();

  protected readonly recipes = inject(ProjectRecipes);
  private readonly i18n = inject(I18n);
  protected readonly maxName = LIMITS.nameLength;
  protected readonly difficulty = {
    beginner: 'recipes.beginner',
    intermediate: 'recipes.intermediate',
    advanced: 'recipes.advanced',
  } as const satisfies Record<TemplateDifficulty, RecipeTextKey>;

  /** The recipe as it is offered now; `null` once its pack is off, updated away or removed. */
  protected readonly recipe = computed(() =>
    this.recipes.find(this.packageId(), this.contributionId()),
  );

  /** A fresh distinct name for every new recipe entry and after every creation. */
  protected readonly name = linkedSignal(() => {
    const recipe = this.recipe();
    return recipe ? this.recipes.defaultName(recipe) : '';
  });

  protected readonly report = signal<Report | null>(null);

  protected readonly canCreate = computed(() => {
    const name = this.name().trim();
    return name.length > 0 && name.length <= LIMITS.nameLength && !this.recipes.creating();
  });

  protected readonly controls = computed(() => {
    const controls = this.recipe()?.payload.controls ?? [];
    const list = this.i18n.formatList(controls.map((control) => control.label ?? control.key));
    return this.recipes.text('recipes.controls', { list });
  });

  constructor() {
    // A preview belongs to the card that started it.
    inject(DestroyRef).onDestroy(() => {
      const ref = `${this.packageId()}/${this.contributionId()}`;
      if (this.recipes.previewing() === ref) this.recipes.previewing.set(null);
    });
  }

  protected togglePreview(ref: string): void {
    this.recipes.previewing.update((current) => (current === ref ? null : ref));
  }

  protected async create(entry: ActiveTemplate): Promise<void> {
    if (!this.canCreate()) return;
    this.report.set(null);
    const outcome = await this.recipes.create(
      entry.installed.id,
      entry.contribution.id,
      this.name(),
    );
    this.report.set(this.describe(outcome));
    if (outcome.status === 'created') this.created.emit(outcome.name);
  }

  private describe(outcome: RecipeOutcome): Report {
    switch (outcome.status) {
      case 'created':
        return { text: this.recipes.text('recipes.created', { name: outcome.name }), error: false };
      case 'cancelled':
        return { text: this.recipes.text('recipes.cancelled'), error: false };
      case 'stale':
        return { text: this.i18n.t('plugins.staleResult'), error: true };
      case 'failed':
        return { text: outcome.message, error: true };
    }
  }
}

/** Every active recipe, to create a new shader from. Closes once one is created. */
@Component({
  selector: 'app-recipe-gallery-dialog',
  imports: [MatButtonModule, MatDialogModule, RecipeCard, TranslatePipe],
  template: `
    <h2 mat-dialog-title>{{ recipes.text('recipes.title') }}</h2>
    <mat-dialog-content data-testid="recipe-gallery">
      <p class="muted">{{ recipes.text('recipes.intro') }}</p>
      @for (entry of recipes.recipes(); track entry.ref) {
        <app-recipe-card
          [packageId]="entry.installed.id"
          [contributionId]="entry.contribution.id"
          (created)="close()"
        />
      } @empty {
        <p class="muted" data-testid="recipe-gallery-empty">{{ recipes.text('recipes.empty') }}</p>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button matButton mat-dialog-close type="button" data-testid="recipe-gallery-close">
        {{ 'action.close' | translate }}
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    .muted {
      margin: 0;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
    }

    app-recipe-card + app-recipe-card {
      display: block;
      border-top: 1px solid var(--mat-sys-outline-variant);
    }
  `,
})
export class RecipeGalleryDialog {
  protected readonly recipes = inject(ProjectRecipes);
  private readonly dialogRef = inject(MatDialogRef);

  protected close(): void {
    this.dialogRef.close();
  }
}
