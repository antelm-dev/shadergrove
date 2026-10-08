import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { Router } from '@angular/router';

import { VERTEX_DOC } from '@shadergrove/shared/diagnostic';
import {
  CAPABILITY_PROFILES,
  type AnalyzerFinding,
  type AnalyzerReport,
  type CapabilityProfileId,
  type FindingLocation,
  type ResourceState,
} from '@shadergrove/shared/plugin';
import { EditorNavigation } from '../../editor/editor-navigation';
import { I18n, type TranslationParams } from '../../i18n/i18n';
import type { TranslationKey } from '../../i18n/keys';
import { RendererHandle } from '../../rendering/renderer-handle';
import { ShaderStore } from '../../workspace/shader-store';
import { PluginTools, type ToolSession } from '../plugin-tools';
import { doctorSlotStates, doctorSnapshot, doctorSource } from './doctor-source';

/** The host text this panel shows; the dictionaries gain them with the coordinator's i18n fragment. */
export type DoctorKey =
  | 'doctor.command'
  | 'doctor.target'
  | 'doctor.run'
  | 'doctor.cancel'
  | 'doctor.running'
  | 'doctor.noShader'
  | 'doctor.stale'
  | 'doctor.summary'
  | 'doctor.coverage'
  | 'doctor.noFindings'
  | 'doctor.show'
  | 'doctor.profileStudio'
  | 'doctor.profileWallpaper'
  | 'doctor.severityError'
  | 'doctor.severityWarning'
  | 'doctor.severityInfo'
  | 'doctor.coverageChecked'
  | 'doctor.coverageStructural'
  | 'doctor.coverageUnchecked'
  | 'doctor.confidenceCertain'
  | 'doctor.confidenceLikely'
  | 'doctor.confidencePossible';

const PROFILE_KEYS: Record<CapabilityProfileId, DoctorKey> = {
  'studio-webgl2/v1': 'doctor.profileStudio',
  'wallpaper-web/v1': 'doctor.profileWallpaper',
};
const SEVERITY_KEYS: Record<AnalyzerFinding['severity'], DoctorKey> = {
  error: 'doctor.severityError',
  warning: 'doctor.severityWarning',
  info: 'doctor.severityInfo',
};
const COVERAGE_KEYS: Record<AnalyzerFinding['coverage'], DoctorKey> = {
  checked: 'doctor.coverageChecked',
  structural: 'doctor.coverageStructural',
  unchecked: 'doctor.coverageUnchecked',
};
const CONFIDENCE_KEYS: Record<AnalyzerFinding['confidence'], DoctorKey> = {
  certain: 'doctor.confidenceCertain',
  likely: 'doctor.confidenceLikely',
  possible: 'doctor.confidencePossible',
};

/** How often the preview's texture load outcomes are looked at again: reading them is cheap. */
const OBSERVE_MS = 1000;

/**
 * Shader Doctor's report: the open draft checked against one capability
 * profile the user picks among those the analyzer declares.
 *
 * A report shows only while it still describes the draft, the record's
 * texture slots and their observed load states, and the target it ran for;
 * anything else reads "out of date". Findings are the analyzer's own, listed
 * here only: the compiler's diagnostics and editor markers are never touched.
 * A finding with a location takes the user to the editor — its line, or for a
 * binding the pass that holds it.
 */
@Component({
  selector: 'app-doctor-panel',
  imports: [MatButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    .doctor {
      display: grid;
      gap: 0.5rem;
    }
    .controls {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      align-items: center;
    }
    .muted {
      color: var(--mat-sys-on-surface-variant);
    }
    .findings {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 0.375rem;
    }
    .finding {
      display: grid;
      gap: 0.125rem;
      padding: 0.5rem 0.75rem;
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: var(--mat-sys-corner-small, 8px);
    }
    .finding[data-severity='error'] {
      border-color: var(--mat-sys-error);
    }
    .meta {
      font: var(--mat-sys-label-small);
      color: var(--mat-sys-on-surface-variant);
    }
  `,
  template: `
    <div class="doctor" data-testid="doctor-panel">
      <div class="controls">
        <label>
          {{ t('doctor.target') }}
          <select
            data-testid="doctor-target"
            [value]="target()"
            (change)="choose($any($event.target).value)"
          >
            @for (id of profiles(); track id) {
              <option [value]="id">{{ profileName(id) }}</option>
            }
          </select>
        </label>
        @if (running()) {
          <button matButton type="button" data-testid="doctor-cancel" (click)="own()?.cancel()">
            {{ t('doctor.cancel') }}
          </button>
        } @else {
          <button
            matButton="tonal"
            type="button"
            data-testid="doctor-run"
            [disabled]="!hasShader()"
            (click)="run()"
          >
            {{ t('doctor.run') }}
          </button>
        }
      </div>

      @if (!hasShader()) {
        <p class="muted" data-testid="doctor-no-shader">{{ t('doctor.noShader') }}</p>
      }
      @if (running()) {
        <p class="muted" role="status" data-testid="doctor-running">{{ t('doctor.running') }}</p>
      }
      @if (error(); as message) {
        <p role="alert" data-testid="doctor-error">{{ message }}</p>
      }
      @if (stale()) {
        <p class="muted" role="status" data-testid="doctor-stale">{{ t('doctor.stale') }}</p>
      }

      @if (report(); as report) {
        <p data-testid="doctor-summary">
          {{
            t('doctor.summary', {
              target: profileName(report.profile),
              errors: count(report, 'error'),
              warnings: count(report, 'warning'),
              infos: count(report, 'info'),
            })
          }}
        </p>
        <p class="muted" data-testid="doctor-coverage">
          {{
            t('doctor.coverage', {
              checked: report.checkedRules.length,
              unchecked: report.uncheckedRules.join(', ') || '—',
            })
          }}
        </p>
        @if (report.findings.length === 0) {
          <p data-testid="doctor-clean">{{ t('doctor.noFindings') }}</p>
        } @else {
          <ul class="findings">
            @for (finding of report.findings; track $index) {
              <li
                class="finding"
                data-testid="doctor-finding"
                [attr.data-rule]="finding.ruleId"
                [attr.data-severity]="finding.severity"
                [attr.data-coverage]="finding.coverage"
              >
                <span>
                  <strong>{{ t(severityKey(finding)) }}</strong>
                  {{ finding.message }}
                </span>
                <span class="meta">
                  {{ finding.ruleId }} · {{ t(coverageKey(finding)) }} ·
                  {{ t(confidenceKey(finding)) }}
                  @if (finding.location; as location) {
                    · {{ where(location) }}
                  }
                </span>
                @if (finding.location; as location) {
                  <button
                    matButton
                    type="button"
                    data-testid="doctor-show"
                    (click)="show(location)"
                  >
                    {{ t('doctor.show') }}
                  </button>
                }
              </li>
            }
          </ul>
        }
      }
    </div>
  `,
})
export class DoctorPanel {
  /** The outlet's session: names the tool. The panel runs its own, tied to texture state too. */
  readonly session = input.required<ToolSession>();

  private readonly tools = inject(PluginTools);
  private readonly store = inject(ShaderStore);
  private readonly renderer = inject(RendererHandle);
  private readonly router = inject(Router);
  private readonly navigation = inject(EditorNavigation);
  private readonly i18n = inject(I18n);

  /** The preview's load outcome per slot, as last observed; equal lists do not notify. */
  private readonly states = signal<readonly ResourceState[]>([], {
    equal: (a, b) => a.join() === b.join(),
  });
  private readonly source = doctorSource(
    () => this.tools.draftSource(),
    () => this.store.channels(),
    () => this.states(),
  );

  /**
   * The session the panel runs requests in: the same tool as the outlet's, but
   * with a source that also covers the record's textures and their load
   * states, so assigning or clearing an image retires a report (the draft's
   * fingerprint alone does not see textures). A new outlet session — the
   * package updated or reinstalled — gets a new one; the old one is closed.
   */
  protected readonly own = computed(() => {
    const session = this.session();
    return untracked(() =>
      this.tools.openSession(session.packageId, session.contributionId, { source: this.source }),
    );
  });

  /** The profiles the analyzer declares, in its order. */
  protected readonly profiles = computed<readonly CapabilityProfileId[]>(() => {
    const session = this.session();
    const contribution = this.tools.find(session.packageId, session.contributionId)?.contribution;
    return contribution?.kind === 'analyzer' ? contribution.profiles : [];
  });
  private readonly chosen = signal<CapabilityProfileId | null>(null);
  protected readonly target = computed(() => {
    const chosen = this.chosen();
    const profiles = this.profiles();
    return chosen && profiles.includes(chosen) ? chosen : (profiles[0] ?? null);
  });

  protected readonly hasShader = computed(() => this.tools.draftSource() !== null);
  protected readonly running = computed(() => this.own()?.running() ?? false);
  protected readonly error = computed(() => this.own()?.error() ?? null);
  protected readonly stale = computed(() => this.own()?.stale() ?? false);
  protected readonly report = computed(
    () => (this.own()?.result()?.value as AnalyzerReport | undefined) ?? null,
  );

  constructor() {
    effect((onCleanup) => {
      const own = this.own();
      onCleanup(() => own?.close());
    });
    this.observe();
    const timer = setInterval(() => this.observe(), OBSERVE_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected t(key: DoctorKey, params?: TranslationParams): string {
    return this.i18n.t(key as TranslationKey, params);
  }

  protected profileName(id: CapabilityProfileId): string {
    return `${this.t(PROFILE_KEYS[id])} (v${CAPABILITY_PROFILES[id].version})`;
  }

  protected severityKey = (finding: AnalyzerFinding) => SEVERITY_KEYS[finding.severity];
  protected coverageKey = (finding: AnalyzerFinding) => COVERAGE_KEYS[finding.coverage];
  protected confidenceKey = (finding: AnalyzerFinding) => CONFIDENCE_KEYS[finding.confidence];

  protected count(report: AnalyzerReport, severity: AnalyzerFinding['severity']): number {
    return report.findings.filter((finding) => finding.severity === severity).length;
  }

  /** A location as the editor names it: the document, and the line or channel. */
  protected where(location: FindingLocation): string {
    if (location.kind === 'vertex') return `Vertex:${location.line}`;
    const project = this.store.draft()?.project;
    if (location.kind === 'binding') {
      const pass = project?.passes.find((candidate) => candidate.id === location.passId);
      return `${pass?.name ?? location.passId} · iChannel${location.channel}`;
    }
    const documents = location.kind === 'pass' ? project?.passes : project?.files;
    const name = documents?.find((document) => document.id === location.id)?.name ?? location.id;
    return `${name}:${location.line}`;
  }

  /** Switch target: the old target's report stops showing at once, and the new one is checked. */
  protected choose(id: string): void {
    const profile = this.profiles().find((candidate) => candidate === id);
    if (!profile) return;
    this.chosen.set(profile);
    if (this.hasShader()) void this.run();
  }

  protected async run(): Promise<void> {
    const session = this.own();
    const target = this.target();
    if (!session || !target) return;
    this.observe();
    // Taken from the store in this same tick, as `analyze` requires.
    const snapshot = doctorSnapshot(this.store, this.states());
    if (!snapshot) return;
    await session.analyze(target, snapshot);
  }

  /** Open the editor at a finding, if the report still holds. */
  protected async show(location: FindingLocation): Promise<void> {
    await this.own()?.deliver(async (_report, check) => {
      check();
      if (location.kind === 'binding') this.navigation.reveal(location.passId, 0);
      else
        this.navigation.reveal(
          location.kind === 'vertex' ? VERTEX_DOC : location.id,
          location.line,
        );
      // Revealed first: leaving Plugins destroys this panel and closes its session. The
      // editor underneath picks the request up.
      await this.router.navigateByUrl('/');
    });
  }

  private observe(): void {
    this.states.set(
      doctorSlotStates(
        this.store.channels(),
        this.store.draft()?.project ?? null,
        this.renderer.engine(),
      ),
    );
  }
}
