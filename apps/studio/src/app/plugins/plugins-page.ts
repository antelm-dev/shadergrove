import { NgTemplateOutlet, isPlatformBrowser } from '@angular/common';
import {
  Component,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  PLATFORM_ID,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import type { CustomEffect, ShaderControl, ShaderParams } from '@shadergrove/shared/model';
import {
  PLUGIN_LIMITS,
  effectContributionCandidate,
  validateEffectCandidate,
  type EffectContribution,
  type ExporterContribution,
  type ImporterContribution,
  type CatalogueEntry,
  type PluginContribution,
  type ProjectExporterContribution,
  type ProjectImporterContribution,
  type ThemeContribution,
  pluginThemeRef,
} from '@shadergrove/shared/plugin';
import { APP_VERSION } from '@shadergrove/shared/version';
import { defaultParams } from '@shadergrove/shared/validate';
import { DesktopPlatform } from '../desktop/desktop-platform';
import { I18n } from '../i18n/i18n';
import { TranslatePipe } from '../i18n/translate.pipe';
import { PAGE_STYLES } from '../publications/page';
import { AppThemes } from '../themes/app-themes';
import { ShaderStore } from '../workspace/shader-store';
import { EffectAdoption, adoptionMessage, type AdoptionResult } from './effect-adoption';
import { HostAdapters } from './host-adapters';
import { PluginCatalogueService } from './plugin-catalogue';
import { PluginCommands } from './plugin-commands';
import {
  PluginInstallations,
  type InstalledPlugin,
  type PluginReview,
} from './plugin-installations';
import { PluginToolsOutlet } from './plugin-tools-outlet';
import { ProjectPluginActions, type ProjectActionOutcome } from './project-actions';
import { RecipeCard } from './tools/recipes-panel';

type Message = { text: string; error: boolean; warnings?: readonly string[] };
type AvailableState = 'install' | 'update' | 'installed';

/**
 * `/plugins`: the locally installed plugins, laid over the editor like
 * Explore so the open shader — the one effects are added to — stays where it is.
 *
 * Everything shown is built by the host from a package's manifest: its
 * identity, what it contributes, and for each importer or exporter a form made
 * from the simple controls it declares. A plugin never draws here, picks a
 * file, or writes one; the host does all three and keeps what comes back only
 * once it has validated — and for effects, compiled — it.
 */
@Component({
  selector: 'app-plugins-page',
  imports: [
    FormsModule,
    NgTemplateOutlet,
    MatButtonModule,
    MatIconModule,
    MatSlideToggleModule,
    PluginToolsOutlet,
    RecipeCard,
    RouterLink,
    TranslatePipe,
  ],
  template: `
    <header class="page-bar">
      <a matButton routerLink="/">
        <mat-icon>arrow_back</mat-icon>
        {{ 'plugins.backToEditor' | translate }}
      </a>
      <h1>{{ 'plugins.title' | translate }}</h1>
    </header>

    <main [attr.aria-busy]="installations.loading()">
      <h2 class="section">{{ 'plugins.available' | translate }}</h2>
      <p class="hint">{{ 'plugins.availableHint' | translate }}</p>
      @switch (catalogue.state().status) {
        @case ('ready') {
          @if (available().length === 0) {
            <p class="status">{{ 'plugins.availableEmpty' | translate }}</p>
          }
        }
        @case ('error') {
          <p class="error" role="alert" data-testid="catalogue-error">
            {{ 'plugins.availableError' | translate: { message: catalogueError() } }}
          </p>
        }
        @default {
          <p class="status">{{ 'plugins.availableLoading' | translate }}</p>
        }
      }
      @for (entry of available(); track entry.id) {
        @let state = availableState(entry);
        <article
          class="plugin available"
          [class.focused]="focus() === entry.id"
          [attr.id]="'available-' + entry.id"
          [attr.data-testid]="'available-' + entry.id"
          [attr.aria-label]="entry.name"
        >
          <header>
            <div class="identity">
              <h3>{{ entry.name }}</h3>
              <p>{{ entry.description }}</p>
              <p class="muted">
                {{ entry.id }} · {{ 'plugins.version' | translate: { version: entry.version } }} ·
                {{ 'plugins.by' | translate: { publisher: entry.publisher } }} ·
                {{ 'plugins.license' | translate: { license: entry.license } }}
              </p>
              <p class="muted">{{ 'plugins.official' | translate }}</p>
            </div>
            @switch (state) {
              @case ('installed') {
                <span class="muted" [attr.data-testid]="'available-installed-' + entry.id">
                  {{ 'plugins.upToDate' | translate }}
                </span>
              }
              @default {
                <button
                  matButton="tonal"
                  type="button"
                  [attr.data-testid]="'install-available-' + entry.id"
                  [disabled]="busy() !== null || installations.loading()"
                  (click)="installAvailable(entry)"
                >
                  {{
                    state === 'update'
                      ? ('plugins.updateTo' | translate: { version: entry.version })
                      : ('plugins.installAvailable' | translate: { name: entry.name })
                  }}
                </button>
              }
            }
          </header>
          <ul class="contributions">
            @for (contribution of entry.contributions; track contribution.id) {
              <li>
                <strong>{{ kindName(contribution.kind) }}</strong> — {{ contribution.name }}
              </li>
            }
          </ul>
        </article>
      }

      <section class="install" [attr.aria-label]="'plugins.installFromFile' | translate">
        <button
          matButton="tonal"
          type="button"
          data-testid="plugin-pick"
          (click)="packageInput.click()"
        >
          <mat-icon>upload_file</mat-icon>
          {{ 'plugins.installFromFile' | translate }}
        </button>
        <input
          #packageInput
          hidden
          type="file"
          accept=".sgplugin.json,.json,application/json"
          data-testid="plugin-file"
          (change)="pickPackage(packageInput)"
        />
        <p class="hint">{{ 'plugins.installHint' | translate }}</p>

        @if (review(); as current) {
          <div
            class="review"
            data-testid="plugin-review"
            role="region"
            [attr.aria-label]="'plugins.review' | translate"
          >
            @if (current.ok) {
              @let manifest = current.plugin.manifest;
              <h2>
                {{ manifest.name }} <span class="muted">{{ manifest.id }}</span>
              </h2>
              <p>
                {{ 'plugins.version' | translate: { version: manifest.version } }} ·
                {{ 'plugins.by' | translate: { publisher: manifest.publisher } }} ·
                {{ 'plugins.license' | translate: { license: manifest.license } }}
              </p>
              <p class="warning">{{ 'plugins.unsigned' | translate }}</p>
              @if (current.replaces) {
                <p>{{ 'plugins.replaces' | translate: { version: current.replaces } }}</p>
              }
              <ul class="contributions">
                @for (contribution of manifest.contributions; track contribution.id) {
                  <li>
                    <strong>{{ kindLabel(contribution) }}</strong> — {{ contribution.name }}
                    <span class="muted">{{ detail(contribution) }}</span>
                  </li>
                }
              </ul>
              <p class="muted">{{ limits() }}</p>
              @if (!current.compatible) {
                <p class="error" role="alert">
                  {{
                    'plugins.incompatible'
                      | translate: { range: manifest.appVersionRange, version: appVersion }
                  }}
                </p>
              }
              <div class="actions">
                <button matButton type="button" (click)="review.set(null)">
                  {{ 'plugins.cancel' | translate }}
                </button>
                <button
                  matButton="filled"
                  type="button"
                  data-testid="plugin-install"
                  [disabled]="!current.compatible || busy() !== null"
                  (click)="install(current)"
                >
                  {{ 'plugins.install' | translate }}
                </button>
              </div>
            } @else {
              <p class="error" role="alert">{{ 'plugins.invalidPackage' | translate }}</p>
              <ul class="error">
                @for (error of current.errors; track $index) {
                  <li>{{ error }}</li>
                }
              </ul>
              <div class="actions">
                <button matButton type="button" (click)="review.set(null)">
                  {{ 'plugins.cancel' | translate }}
                </button>
              </div>
            }
          </div>
        }
      </section>

      @if (message(); as current) {
        <div
          class="message"
          [class.error]="current.error"
          [attr.role]="current.error ? 'alert' : 'status'"
          data-testid="plugin-message"
        >
          <p>{{ current.text }}</p>
          @if (current.warnings?.length) {
            <p class="muted">{{ 'plugins.warnings' | translate }}</p>
            <ul data-testid="plugin-warnings">
              @for (warning of current.warnings; track $index) {
                <li>{{ warning }}</li>
              }
            </ul>
          }
        </div>
      }

      <h2 class="section">{{ 'plugins.installed' | translate }}</h2>
      @if (installations.plugins().length === 0 && !installations.loading()) {
        <p class="status">{{ 'plugins.empty' | translate }}</p>
      }

      @for (installed of installations.plugins(); track installed.id) {
        <article
          class="plugin"
          [class.focused]="focus() === installed.id"
          [attr.id]="'installed-' + installed.id"
          [attr.data-testid]="'plugin-' + installed.id"
          [attr.aria-label]="title(installed)"
        >
          <header>
            <div class="identity">
              <h3>{{ title(installed) }}</h3>
              @if (installed.plugin; as plugin) {
                <p class="muted">
                  {{ plugin.manifest.id }} ·
                  {{ 'plugins.version' | translate: { version: plugin.manifest.version } }} ·
                  {{ 'plugins.by' | translate: { publisher: plugin.manifest.publisher } }} ·
                  {{ 'plugins.license' | translate: { license: plugin.manifest.license } }}
                </p>
              }
              @if (installed.problem) {
                <p class="error" role="alert">{{ installed.problem }}</p>
              }
            </div>
            <mat-slide-toggle
              [attr.data-testid]="'plugin-enable-' + installed.id"
              [attr.aria-label]="'plugins.enable' | translate: { name: title(installed) }"
              [disabled]="installed.problem !== null || busy() !== null"
              [ngModel]="installed.active"
              (ngModelChange)="setEnabled(installed, $event)"
            />
            <button
              matIconButton
              type="button"
              [attr.data-testid]="'plugin-remove-' + installed.id"
              [attr.aria-label]="'plugins.remove' | translate: { name: title(installed) }"
              [disabled]="busy() !== null"
              (click)="remove(installed)"
            >
              <mat-icon>delete</mat-icon>
            </button>
          </header>

          @if (installed.plugin; as plugin) {
            <ul class="contributions">
              @for (contribution of plugin.manifest.contributions; track contribution.id) {
                @let key = installed.id + '/' + contribution.id;
                <li class="contribution" [attr.data-testid]="'contribution-' + key">
                  <div>
                    @if (contribution.kind === 'theme') {
                      @let palette = asTheme(contribution).ui;
                      <span
                        class="swatch"
                        aria-hidden="true"
                        [style.background]="palette.background"
                      >
                        <i [style.background]="palette['surface-container-high']"></i>
                        <i [style.background]="palette.primary"></i>
                        <i [style.background]="palette['on-surface']"></i>
                      </span>
                    }
                    <strong>{{ kindLabel(contribution) }}</strong> — {{ contribution.name }}
                    <span class="muted">{{ detail(contribution) }}</span>
                  </div>
                  @if (!installed.active) {
                    <p class="muted">{{ 'plugins.enableToUse' | translate }}</p>
                  } @else {
                    @switch (contribution.kind) {
                      @case ('effect') {
                        <button
                          matButton="tonal"
                          type="button"
                          [attr.data-testid]="'add-' + key"
                          [disabled]="busy() !== null"
                          (click)="addEffect(installed, asEffect(contribution))"
                        >
                          {{ 'plugins.addToShader' | translate }}
                        </button>
                      }
                      @case ('importer') {
                        @let importer = asImporter(contribution);
                        <ng-container
                          [ngTemplateOutlet]="paramsForm"
                          [ngTemplateOutletContext]="{ key, controls: importer.params }"
                        />
                        <button
                          matButton="tonal"
                          type="button"
                          [attr.data-testid]="'import-' + key"
                          [disabled]="busy() !== null"
                          (click)="importInput.click()"
                        >
                          {{ 'plugins.chooseFile' | translate }}
                        </button>
                        <input
                          #importInput
                          hidden
                          type="file"
                          [attr.data-testid]="'import-file-' + key"
                          [accept]="accept(importer)"
                          (change)="runImporter(installed, importer, importInput)"
                        />
                      }
                      @case ('theme') {
                        @let ref = themeRef(installed, contribution);
                        @if (themes.isPluginSelected(ref)) {
                          <p class="muted" [attr.data-testid]="'theme-in-use-' + key">
                            {{ 'plugins.themeInUse' | translate }}
                          </p>
                        } @else {
                          <button
                            matButton="tonal"
                            type="button"
                            [attr.data-testid]="'use-theme-' + key"
                            (click)="themes.selectPlugin(ref)"
                          >
                            {{ 'plugins.useTheme' | translate }}
                          </button>
                        }
                      }
                      @case ('language') {
                        <!-- Data like a theme: choosing it is all there is to do with it. -->
                        @let ref = themeRef(installed, contribution);
                        @if (i18n.isSelected(ref)) {
                          <p class="muted" [attr.data-testid]="'language-in-use-' + key">
                            {{ 'plugins.languageInUse' | translate }}
                          </p>
                        } @else {
                          <button
                            matButton="tonal"
                            type="button"
                            [attr.data-testid]="'use-language-' + key"
                            (click)="i18n.select(ref)"
                          >
                            {{ 'plugins.useLanguage' | translate }}
                          </button>
                        }
                      }
                      @case ('projectImporter') {
                        @let importer = asProjectImporter(contribution);
                        @if (importer.provider && !providerOf(importer)) {
                          <p class="muted">{{ 'plugins.noAdapter' | translate }}</p>
                        } @else {
                          <!-- The same dialog the editor's import commands open. -->
                          <button
                            matButton="filled"
                            type="button"
                            [attr.data-testid]="'open-import-' + key"
                            [disabled]="busy() !== null || projects.running() !== null"
                            (click)="openImport(installed, importer)"
                          >
                            {{ 'action.import' | translate }}
                          </button>
                        }
                      }
                      @case ('projectTemplate') {
                        <app-recipe-card
                          [packageId]="installed.id"
                          [contributionId]="contribution.id"
                        />
                      }
                      @case ('projectExporter') {
                        @let exporter = asProjectExporter(contribution);
                        @if (!runtimeOf(exporter)) {
                          <p class="muted">{{ 'plugins.noAdapter' | translate }}</p>
                        } @else {
                          <p class="muted">{{ 'plugins.exportHint' | translate }}</p>
                          <ng-container
                            [ngTemplateOutlet]="runControls"
                            [ngTemplateOutletContext]="{ key, label: 'plugins.runExport' }"
                          />
                        }
                      }
                      @case ('exporter') {
                        @let exporter = asExporter(contribution);
                        @if (customEffects().length === 0) {
                          <p class="muted">{{ 'plugins.noCustomEffects' | translate }}</p>
                        } @else {
                          <label class="field">
                            <span>{{ 'plugins.exportEffect' | translate }}</span>
                            <select
                              [attr.data-testid]="'export-effect-' + key"
                              [ngModel]="chosenEffect(key)"
                              (ngModelChange)="chooseEffect(key, $event)"
                            >
                              @for (effect of customEffects(); track effect.instanceId) {
                                <option [value]="effect.instanceId">
                                  {{ effect.definition.name }}
                                </option>
                              }
                            </select>
                          </label>
                          <ng-container
                            [ngTemplateOutlet]="paramsForm"
                            [ngTemplateOutletContext]="{ key, controls: exporter.params }"
                          />
                          <button
                            matButton="tonal"
                            type="button"
                            [attr.data-testid]="'export-' + key"
                            [disabled]="busy() !== null"
                            (click)="runExporter(installed, exporter, key)"
                          >
                            {{ 'plugins.export' | translate }}
                          </button>
                        }
                      }
                    }
                  }
                </li>
              }
            </ul>
            <!-- The package's tools: host panels drawn by their registered adapters. -->
            <app-plugin-tools-outlet [packageId]="installed.id" />
          }
        </article>
      }
    </main>

    <!-- Run, progress and cancel for one project contribution. -->
    <ng-template #runControls let-key="key" let-label="label">
      @let running = projects.running();
      @let runningHere = running && running.pluginId + '/' + running.contributionId === key;
      <div class="run">
        <button
          matButton="filled"
          type="button"
          [attr.data-testid]="'run-' + key"
          [disabled]="busy() !== null || running !== null"
          (click)="runExport(key)"
        >
          {{ label | translate }}
        </button>
        @if (runningHere) {
          <span class="muted" role="status" [attr.data-testid]="'step-' + key">
            {{ stepLabel(running.step) }}
          </span>
          <button
            matButton
            type="button"
            [attr.data-testid]="'cancel-' + key"
            (click)="projects.cancel()"
          >
            {{ 'plugins.cancelRun' | translate }}
          </button>
        }
      </div>
    </ng-template>

    <!-- A form built from the simple controls a contribution declares; values kept per contribution. -->
    <ng-template #paramsForm let-key="key" let-controls="controls">
      @for (control of asControls(controls); track control.key) {
        <label class="field">
          <span>{{ control.label ?? control.key }}</span>
          @switch (control.type) {
            @case ('number') {
              <input
                type="number"
                [min]="control.min"
                [max]="control.max"
                [step]="control.step ?? 'any'"
                [ngModel]="param(key, controls, control.key)"
                (ngModelChange)="setParam(key, controls, control.key, +$event)"
              />
            }
            @case ('boolean') {
              <input
                type="checkbox"
                [ngModel]="param(key, controls, control.key)"
                (ngModelChange)="setParam(key, controls, control.key, $event)"
              />
            }
            @case ('color') {
              <input
                type="color"
                [ngModel]="param(key, controls, control.key)"
                (ngModelChange)="setParam(key, controls, control.key, $event)"
              />
            }
            @case ('select') {
              <select
                [ngModel]="param(key, controls, control.key)"
                (ngModelChange)="setParam(key, controls, control.key, +$event)"
              >
                @for (option of optionsOf(control); track option[0]) {
                  <option [ngValue]="option[1]">{{ option[0] }}</option>
                }
              </select>
            }
          }
        </label>
      }
    </ng-template>
  `,
  styles: `
    ${PAGE_STYLES}

    .install,
    .plugin {
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-bottom: 16px;
      padding: 16px;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: var(--mat-sys-corner-medium, 12px);
    }

    .install {
      align-items: flex-start;
    }

    .review {
      align-self: stretch;
      padding: 12px 16px;
      border-radius: var(--mat-sys-corner-small, 8px);
      background: var(--mat-sys-surface-container);
    }

    .review h2,
    .plugin h3 {
      margin: 0;
      font: var(--mat-sys-title-medium);
    }

    .plugin > header {
      display: flex;
      align-items: flex-start;
      gap: 8px;
    }

    .identity {
      flex: 1;
      min-width: 0;
    }

    .identity p,
    .review p,
    .hint {
      margin: 4px 0;
    }

    .section {
      margin: 24px 0 12px;
      font: var(--mat-sys-title-large);
    }

    .contributions {
      margin: 8px 0 0;
      padding-left: 18px;
    }

    .contribution {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 6px;
      padding: 6px 0;
    }

    .swatch {
      display: inline-flex;
      align-items: flex-end;
      gap: 2px;
      width: 20px;
      height: 20px;
      margin-right: 6px;
      padding: 3px;
      box-sizing: border-box;
      vertical-align: middle;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: 3px;
    }

    .swatch i {
      flex: 1;
      height: 60%;
      border-radius: 1px;
    }

    .field {
      display: flex;
      align-items: center;
      gap: 8px;
      font: var(--mat-sys-body-medium);
    }

    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }

    .plugin.focused {
      border-color: var(--mat-sys-primary);
      box-shadow: 0 0 0 1px var(--mat-sys-primary);
    }

    .available p {
      margin: 4px 0;
    }

    .run {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 12px;
    }

    .message ul {
      margin: 4px 0 0;
      padding-left: 18px;
    }

    .muted,
    .hint {
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-body-small);
    }

    .warning {
      color: var(--mat-sys-tertiary);
    }

    .error {
      color: var(--mat-sys-error);
    }

    .message {
      margin: 0 0 16px;
      font: var(--mat-sys-body-medium);
    }
  `,
})
export class PluginsPage {
  protected readonly installations = inject(PluginInstallations);
  protected readonly themes = inject(AppThemes);
  private readonly adoption = inject(EffectAdoption);
  private readonly store = inject(ShaderStore);
  private readonly desktop = inject(DesktopPlatform);
  protected readonly i18n = inject(I18n);
  private readonly adapters = inject(HostAdapters);
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);
  protected readonly catalogue = inject(PluginCatalogueService);
  protected readonly projects = inject(ProjectPluginActions);
  private readonly commands = inject(PluginCommands);
  private readonly router = inject(Router);

  private readonly route = inject(ActivatedRoute);
  /**
   * The package a link asked to show (`/plugins?use=<id>`), highlighted and
   * scrolled to. Followed, not read once: a link to another package while this
   * page is open reuses the page.
   */
  protected readonly focus = toSignal(
    this.route.queryParamMap.pipe(map((params) => params.get('use'))),
    { initialValue: this.route.snapshot.queryParamMap.get('use') },
  );
  protected readonly available = computed(() => {
    const state = this.catalogue.state();
    return state.status === 'ready' ? state.packages : [];
  });
  protected readonly catalogueError = computed(() => {
    const state = this.catalogue.state();
    return state.status === 'error' ? state.message : '';
  });

  protected readonly appVersion = APP_VERSION;
  protected readonly review = signal<PluginReview | null>(null);
  protected readonly message = signal<Message | null>(null);
  /** The action under way, if any: one plugin call at a time. */
  protected readonly busy = signal<string | null>(null);

  private readonly params = signal<Record<string, ShaderParams>>({});
  private readonly chosen = signal<Record<string, string>>({});

  /** The open shader's custom effects — what an exporter can be pointed at. */
  protected readonly customEffects = computed(() =>
    (this.store.draft()?.render.postProcessing.effects ?? []).filter(
      (effect): effect is CustomEffect => effect.type === 'custom',
    ),
  );

  constructor() {
    // A package picked under one account is not offered for install under another.
    effect(() => {
      this.installations.profile();
      untracked(() => this.review.set(null));
    });
    void this.catalogue.load();
    // Scroll to the package a link asked for, once per link, as soon as its card is on the page.
    afterNextRender(() => this.scrollToFocus());
    effect(() => {
      this.installations.plugins();
      this.available();
      const focus = this.focus();
      if (!focus) this.scrolledTo = null;
      // Only in the browser: a server render has no page to scroll (nor `CSS`).
      if (focus && this.scrolledTo !== focus && isPlatformBrowser(this.platform)) {
        untracked(() => setTimeout(() => this.scrollToFocus()));
      }
    });
  }

  protected readonly limits = computed(() =>
    this.i18n.t('plugins.limits', {
      input: PLUGIN_LIMITS.fileBytes,
      output: PLUGIN_LIMITS.callOutputBytes,
      seconds: PLUGIN_LIMITS.callTimeoutMs / 1000,
    }),
  );

  // --- Installing -----------------------------------------------------------

  protected async pickPackage(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.message.set(null);
    if (file.size > PLUGIN_LIMITS.packageBytes) {
      this.review.set({
        ok: false,
        errors: [this.i18n.t('plugins.tooLarge', { max: PLUGIN_LIMITS.packageBytes })],
      });
      return;
    }
    // The read is asynchronous; what it reviews belongs to the profile it was picked under.
    const profile = this.installations.profile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (this.installations.profile() !== profile) return;
    this.review.set(this.installations.review(bytes));
  }

  protected async install(review: Extract<PluginReview, { ok: true }>): Promise<void> {
    await this.run('install', async () => {
      await this.installations.install(review);
      this.review.set(null);
      this.say('plugins.installedNotice', { name: review.plugin.manifest.name });
    });
  }

  protected async setEnabled(installed: InstalledPlugin, enabled: boolean): Promise<void> {
    await this.run('enable', () => this.installations.setEnabled(installed.id, enabled));
  }

  protected async remove(installed: InstalledPlugin): Promise<void> {
    await this.run('remove', async () => {
      await this.installations.remove(installed.id);
      this.say('plugins.removed', { name: this.title(installed) });
    });
  }

  protected availableState(entry: CatalogueEntry): AvailableState {
    const installed = this.installations.find(entry.id)?.plugin?.manifest.version;
    if (!installed) return 'install';
    return isNewer(entry.version, installed) ? 'update' : 'installed';
  }

  /**
   * Installs (or explicitly updates to) a catalogue package: its bytes are
   * checked against the entry, then reviewed and installed exactly like a
   * file — switched off. A failed update leaves the installed version alone.
   */
  protected async installAvailable(entry: CatalogueEntry): Promise<void> {
    await this.run(`available:${entry.id}`, async () => {
      const profile = this.installations.profile();
      const bytes = await this.catalogue.fetchPackage(entry);
      if (this.installations.profile() !== profile) {
        this.say('plugins.contextChanged', {}, true);
        return;
      }
      const review = this.installations.review(bytes);
      if (!review.ok) throw new Error(review.errors[0]);
      if (!review.compatible)
        throw new Error(
          this.i18n.t('plugins.incompatible', {
            range: review.plugin.manifest.appVersionRange,
            version: APP_VERSION,
          }),
        );
      if (review.replaces) {
        await this.installations.installReviewedUpdate(review);
        this.say('plugins.updatedNotice', { name: entry.name, version: entry.version });
      } else {
        await this.installations.install(review);
        this.say('plugins.installedNotice', { name: entry.name });
      }
    });
  }

  // --- Project contributions --------------------------------------------------

  protected providerOf(importer: ProjectImporterContribution) {
    return importer.provider ? this.adapters.provider(importer.provider) : null;
  }

  protected runtimeOf(exporter: ProjectExporterContribution) {
    return this.adapters.runtime(exporter.runtime);
  }

  protected stepLabel(step: string): string {
    return this.i18n.t(`plugins.step.${step}` as Parameters<I18n['t']>[0]);
  }

  /** Opens the import dialog the editor's commands open, for this importer. */
  protected async openImport(
    installed: InstalledPlugin,
    importer: ProjectImporterContribution,
  ): Promise<void> {
    this.message.set(null);
    const result = await this.commands.openImport(
      this.installations.context(installed.id),
      importer.id,
    );
    if (result?.toEditor) {
      void this.router.navigateByUrl('/');
    } else if (result?.imported) {
      this.reportOutcome({
        status: 'imported',
        ...result.imported,
        warnings: [...result.imported.warnings],
      });
    }
  }

  /** Runs the project exporter keyed `<package>/<contribution>`. */
  protected async runExport(key: string): Promise<void> {
    const [pluginId, contributionId] = splitKey(key);
    const contribution = this.installations
      .find(pluginId)
      ?.plugin?.manifest.contributions.find((entry) => entry.id === contributionId);
    if (contribution?.kind !== 'projectExporter') return;
    this.message.set(null);
    this.reportOutcome(await this.projects.runExport(pluginId, contributionId));
  }

  private reportOutcome(outcome: ProjectActionOutcome): void {
    switch (outcome.status) {
      case 'imported':
        this.message.set({
          text: this.i18n.t('plugins.importedShader', { name: outcome.name }),
          error: false,
          warnings: outcome.warnings,
        });
        return;
      case 'exported':
        this.message.set({
          text: this.i18n.t('plugins.exportedProject', { where: outcome.where }),
          error: false,
          warnings: outcome.warnings,
        });
        return;
      case 'cancelled':
        this.say('plugins.runCancelled');
        return;
      case 'stale':
        this.say('plugins.staleResult', {}, true);
        return;
      case 'failed':
        this.say('plugins.failed', { message: outcome.message }, true);
        return;
    }
  }

  /** The package last scrolled to: each new link scrolls once. */
  private scrolledTo: string | null = null;
  private readonly platform = inject(PLATFORM_ID);

  private scrollToFocus(): void {
    const id = this.focus();
    if (!id || this.scrolledTo === id) return;
    const element =
      this.host.nativeElement.querySelector<HTMLElement>(`[id="installed-${CSS.escape(id)}"]`) ??
      this.host.nativeElement.querySelector<HTMLElement>(`[id="available-${CSS.escape(id)}"]`);
    if (!element) return;
    this.scrolledTo = id;
    element.scrollIntoView?.({ block: 'center' });
  }

  // --- Using ----------------------------------------------------------------

  protected addEffect(installed: InstalledPlugin, contribution: EffectContribution): void {
    if (!installed.plugin) return;
    this.report(
      this.adoption.adopt(effectContributionCandidate(installed.plugin, contribution)),
      contribution.name,
    );
  }

  protected async runImporter(
    installed: InstalledPlugin,
    importer: ImporterContribution,
    input: HTMLInputElement,
  ): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    // The picker's filter is a convenience; what counts is the name or type the host checks here —
    // and then the content, which the plugin parses and the host revalidates.
    const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
    if (!importer.extensions.includes(extension) && !importer.mime.includes(file.type)) {
      this.say('plugins.fileRefused', {}, true);
      return;
    }
    if (file.size > Math.min(importer.maxInputBytes, PLUGIN_LIMITS.fileBytes)) {
      this.say('plugins.fileTooLarge', {}, true);
      return;
    }
    const host = this.installations.host(installed.id);
    if (!host) return;
    const key = `${installed.id}/${importer.id}`;
    // The call is asynchronous: its result belongs to the profile, shader and plugin it started with.
    const profile = this.installations.profile();
    const shader = this.store.selectedId();
    await this.run(key, async () => {
      const result = await host.importFile(
        importer.id,
        await file.arrayBuffer(),
        this.valuesFor(key, importer.params),
      );
      if (
        this.installations.profile() !== profile ||
        this.store.selectedId() !== shader ||
        !this.installations.find(installed.id)?.active
      ) {
        this.say('plugins.contextChanged', {}, true);
        return;
      }
      const candidate = validateEffectCandidate(result.candidate);
      if (!candidate.ok) {
        this.say('plugins.failed', { message: candidate.errors[0] ?? '' }, true);
        return;
      }
      this.report(this.adoption.adopt(candidate.value), candidate.value.name);
    });
  }

  protected async runExporter(
    installed: InstalledPlugin,
    exporter: ExporterContribution,
    key: string,
  ): Promise<void> {
    const effect = this.customEffects().find((item) => item.instanceId === this.chosenEffect(key));
    const host = this.installations.host(installed.id);
    if (!effect || !host) return;
    await this.run(key, async () => {
      const { name, source, controls } = effect.definition;
      const result = await host.exportEffect(
        exporter.id,
        { name, source, controls, values: effect.values },
        this.valuesFor(key, exporter.params),
      );
      // The plugin only suggests a name. The extension is the one its manifest declared.
      const stem = result.fileName.replace(/\.[^.]*$/, '').replace(/[^\w.-]+/g, '-') || 'effect';
      const filename = `${stem}${exporter.extension}`;
      const bytes = new Uint8Array(result.bytes);
      if (this.desktop.available) {
        if (!(await this.desktop.saveExport(filename, bytes, exporter.extension))) return;
      } else {
        download(new Blob([bytes], { type: result.mime }), filename);
      }
      this.say('plugins.exported', { name: filename });
    });
  }

  // --- Template helpers -------------------------------------------------------

  protected title(installed: InstalledPlugin): string {
    return installed.plugin?.manifest.name ?? installed.id;
  }

  protected kindLabel(contribution: PluginContribution): string {
    return this.kindName(contribution.kind);
  }

  protected kindName(kind: string): string {
    switch (kind) {
      case 'effect':
        return this.i18n.t('plugins.kindEffect');
      case 'importer':
        return this.i18n.t('plugins.kindImporter');
      case 'exporter':
        return this.i18n.t('plugins.kindExporter');
      case 'projectImporter':
        return this.i18n.t('plugins.kindProjectImporter');
      case 'projectExporter':
        return this.i18n.t('plugins.kindProjectExporter');
      case 'language':
        return this.i18n.t('plugins.kindLanguage');
      case 'analyzer':
        return this.i18n.t('plugins.kindAnalyzer');
      case 'assetTool':
        return this.i18n.t('plugins.kindAssetTool');
      case 'projectTemplate':
        return this.i18n.t('plugins.kindProjectTemplate');
      default:
        return this.i18n.t('plugins.kindTheme');
    }
  }

  protected detail(contribution: PluginContribution): string {
    switch (contribution.kind) {
      case 'effect':
        return this.i18n.t('plugins.controls', { count: contribution.controls.length });
      case 'importer':
        return this.i18n.t('plugins.accepts', {
          formats: [...contribution.extensions, ...contribution.mime].join(', '),
        });
      case 'exporter':
        return this.i18n.t('plugins.produces', {
          mime: contribution.mime,
          extension: contribution.extension,
        });
      case 'theme':
        return this.i18n.t(`theme.${contribution.scheme}`);
      case 'projectImporter':
        return this.i18n.t('plugins.importsNew');
      case 'projectExporter':
        return this.i18n.t('plugins.exportsProject', { runtime: contribution.runtime });
      case 'language':
        return this.i18n.t('plugins.languageDetail', {
          name: contribution.nativeName,
          locale: contribution.locale,
        });
      case 'analyzer':
        return contribution.profiles.join(', ');
      case 'assetTool':
        return contribution.workflow;
      case 'projectTemplate':
        return contribution.description;
    }
  }

  protected accept(importer: ImporterContribution): string {
    return [...importer.extensions, ...importer.mime].join(',');
  }

  protected asEffect = (contribution: PluginContribution) => contribution as EffectContribution;
  protected asImporter = (contribution: PluginContribution) => contribution as ImporterContribution;
  protected asExporter = (contribution: PluginContribution) => contribution as ExporterContribution;
  protected asTheme = (contribution: PluginContribution) => contribution as ThemeContribution;
  protected asProjectImporter = (contribution: PluginContribution) =>
    contribution as ProjectImporterContribution;
  protected asProjectExporter = (contribution: PluginContribution) =>
    contribution as ProjectExporterContribution;
  protected themeRef(installed: InstalledPlugin, contribution: PluginContribution) {
    return pluginThemeRef(installed.id, contribution.id);
  }
  protected asControls = (controls: unknown) => controls as ShaderControl[];

  protected optionsOf(control: ShaderControl): [string, number][] {
    return control.type === 'select' ? Object.entries(control.options) : [];
  }

  protected param(key: string, controls: ShaderControl[], name: string): unknown {
    return this.valuesFor(key, controls)[name];
  }

  protected setParam(key: string, controls: ShaderControl[], name: string, value: unknown): void {
    this.params.update((all) => ({
      ...all,
      [key]: { ...this.valuesFor(key, controls), [name]: value as ShaderParams[string] },
    }));
  }

  protected chosenEffect(key: string): string | undefined {
    return this.chosen()[key] ?? this.customEffects()[0]?.instanceId;
  }

  protected chooseEffect(key: string, instanceId: string): void {
    this.chosen.update((all) => ({ ...all, [key]: instanceId }));
  }

  private valuesFor(key: string, controls: ShaderControl[]): ShaderParams {
    return this.params()[key] ?? defaultParams(controls);
  }

  private report(result: AdoptionResult, name: string): void {
    const { key, params, error } = adoptionMessage(result, name);
    this.say(key, params, error);
  }

  private async run(key: string, action: () => Promise<void>): Promise<void> {
    if (this.busy() !== null) throw new Error('A plugin action is already running.');
    this.busy.set(key);
    this.message.set(null);
    try {
      await action();
    } catch (error) {
      this.say(
        'plugins.failed',
        { message: error instanceof Error ? error.message : String(error) },
        true,
      );
    } finally {
      this.busy.set(null);
    }
  }

  private say(
    key: Parameters<I18n['t']>[0],
    params: Record<string, string | number> = {},
    error = false,
  ): void {
    this.message.set({ text: this.i18n.t(key, params), error });
  }
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function splitKey(key: string): [string, string] {
  const slash = key.lastIndexOf('/');
  return [key.slice(0, slash), key.slice(slash + 1)];
}

/** Whether semantic version `a` is newer than `b` (pre-release tags are not ordered). */
function isNewer(a: string, b: string): boolean {
  const parse = (version: string) => version.split(/[.-]/).slice(0, 3).map(Number);
  const [x, y] = [parse(a), parse(b)];
  for (let index = 0; index < 3; index++) {
    if (x[index] !== y[index]) return (x[index] ?? 0) > (y[index] ?? 0);
  }
  return false;
}
