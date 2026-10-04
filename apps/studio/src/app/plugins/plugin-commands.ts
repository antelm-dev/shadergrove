import { Injectable, computed, inject } from '@angular/core';
import { Router } from '@angular/router';

import {
  FALLBACK_LANGUAGE_ID,
  effectContributionCandidate,
  type EffectContribution,
} from '@shadergrove/shared/plugin';
import { I18n } from '../i18n/i18n';
import { AppThemes } from '../themes/app-themes';
import type { MenuCommand } from '../ui/menu-commands';
import { ShaderStore } from '../workspace/shader-store';
import { EffectAdoption, adoptionMessage } from './effect-adoption';
import { HostAdapters } from './host-adapters';
import {
  PluginInstallations,
  type InstalledPlugin,
  type PluginOperationContext,
} from './plugin-installations';
import { ProjectPluginActions } from './project-actions';

/** A menu command that a plugin contribution put there. */
export interface PluginCommand extends MenuCommand {
  /** `<packageId>/<contributionId>`: two packages never share one. */
  readonly ref: string;
}

/**
 * The menu and palette entries that installed plugins contribute.
 *
 * Every list is computed from the current profile's *active* packages —
 * switched on, valid and compatible — so an entry appears when its package is
 * switched on and disappears the moment it is switched off, updated, removed,
 * or the account changes. Nothing here names a package: an entry exists
 * because a contribution of a supported kind does, and where it goes follows
 * from that kind.
 *
 * - `projectImporter` → Import & export: opens its form in Plugins (the host
 *   draws it; a plugin draws nothing).
 * - `projectExporter` → Import & export and the shader's own menu: exports the
 *   open shader directly, dimmed when none is open.
 * - `effect` → the palette's Shader section: adds the effect to the open shader.
 * - `theme` → the palette's Settings section (the Theme submenu lists them too).
 * - `language` → the palette's Settings section (the Language submenu lists
 *   them too), beside the bundled English, which is always there.
 *
 * The app owns the wording: an importer or exporter that uses a host adapter is
 * labelled by that adapter ("Import from Shadertoy…"); otherwise by its
 * contribution name. When two entries would read the same, each names its
 * package, so several plugins doing the same job can be told apart.
 */
@Injectable({ providedIn: 'root' })
export class PluginCommands {
  private readonly installations = inject(PluginInstallations);
  private readonly projects = inject(ProjectPluginActions);
  private readonly adapters = inject(HostAdapters);
  private readonly adoption = inject(EffectAdoption);
  private readonly themes = inject(AppThemes);
  private readonly store = inject(ShaderStore);
  private readonly router = inject(Router);
  private readonly i18n = inject(I18n);

  private readonly noShader = (): boolean => !this.store.record();

  readonly imports = computed<readonly PluginCommand[]>(() =>
    distinguish(
      this.projects.importers().map(({ installed, contribution }) => {
        const command = contribution.provider
          ? this.adapters.provider(contribution.provider)?.command
          : undefined;
        return {
          ref: `${installed.id}/${contribution.id}`,
          package: packageName(installed),
          icon: command?.icon ?? 'input',
          text: () => (command ? this.i18n.t(command.label) : `${contribution.name}…`),
          action: () => void this.openInPlugins(installed.id),
        };
      }),
    ),
  );

  readonly exports = computed<readonly PluginCommand[]>(() =>
    distinguish(
      this.projects.exporters().map(({ installed, contribution }) => {
        const command = this.adapters.runtime(contribution.runtime)?.command;
        const context = this.installations.context(installed.id);
        return {
          ref: `${installed.id}/${contribution.id}`,
          package: packageName(installed),
          icon: command?.icon ?? 'output',
          text: () => (command ? this.i18n.t(command.label) : `${contribution.name}…`),
          disabled: () => this.noShader() || this.projects.running() !== null,
          action: () => void this.runExport(context, contribution.id),
        };
      }),
    ),
  );

  readonly effects = computed<readonly PluginCommand[]>(() =>
    distinguish(
      this.installations
        .plugins()
        .filter((installed) => installed.active && installed.plugin)
        .flatMap((installed) => {
          const context = this.installations.context(installed.id);
          return installed
            .plugin!.manifest.contributions.filter(
              (contribution): contribution is EffectContribution => contribution.kind === 'effect',
            )
            .map((contribution) => ({
              ref: `${installed.id}/${contribution.id}`,
              package: packageName(installed),
              icon: 'auto_awesome',
              text: () => this.i18n.t('action.addPluginEffect', { name: contribution.name }),
              disabled: this.noShader,
              action: () => this.addEffect(context, contribution.id),
            }));
        }),
    ),
  );

  readonly themeCommands = computed<readonly PluginCommand[]>(() =>
    this.themes.entries().map((entry) => ({
      id: `plugin:${entry.ref}`,
      ref: entry.ref,
      icon: () => 'palette',
      label: () => `${this.i18n.t('menu.theme')}: ${entry.theme.name}`,
      action: () => this.themes.selectPlugin(entry.ref),
    })),
  );

  /**
   * Every active language, then the bundled English. Selecting looks the
   * language up again (`I18n.select`), so an entry kept by an open palette
   * cannot bring back one whose package is off, removed or another profile's.
   */
  readonly languageCommands = computed<readonly PluginCommand[]>(() => [
    ...this.i18n.languages().map((entry) => ({
      id: `plugin:${entry.ref}`,
      ref: entry.ref,
      icon: () => 'translate',
      label: () => `${this.i18n.t('menu.language')}: ${this.i18n.label(entry)}`,
      action: () => this.i18n.select(entry.ref),
    })),
    {
      id: `language:${FALLBACK_LANGUAGE_ID}`,
      ref: FALLBACK_LANGUAGE_ID,
      icon: () => 'language',
      label: () => `${this.i18n.t('menu.language')}: ${this.i18n.t('language.fallback')}`,
      action: () => this.i18n.select(FALLBACK_LANGUAGE_ID),
    },
  ]);

  private openInPlugins(packageId: string): Promise<boolean> {
    return this.router.navigate(['/plugins'], { queryParams: { use: packageId } });
  }

  /**
   * The installation a command was built for, if it still is the current one.
   * A command can outlive its list — the palette keeps the commands it opened
   * with — so the package is looked up again, never taken from the closure:
   * switched off, updated, removed or under another profile, it is not run.
   */
  private current(context: PluginOperationContext | null): InstalledPlugin | null {
    if (!context || !this.installations.isCurrent(context)) return null;
    return this.installations.find(context.id) ?? null;
  }

  private stale(): void {
    this.store.notice.set({ text: this.i18n.t('plugins.staleResult'), error: true });
  }

  private async runExport(
    context: PluginOperationContext | null,
    contributionId: string,
  ): Promise<void> {
    const installed = this.current(context);
    if (!installed) return this.stale();
    const name = this.store.record()?.name ?? '';
    const outcome = await this.projects.runExport(installed.id, contributionId);
    switch (outcome.status) {
      case 'exported': {
        const warning = outcome.warnings.length > 0 ? ` ${outcome.warnings.join(' ')}` : '';
        this.store.notice.set({
          text: this.i18n.t('notice.projectExported', { name, where: outcome.where, warning }),
          error: false,
        });
        return;
      }
      case 'failed':
        this.store.notice.set({
          text: this.i18n.t('notice.projectExportFailed', { error: outcome.message }),
          error: true,
        });
        return;
      case 'stale':
        return this.stale();
      case 'cancelled':
        return;
    }
  }

  private addEffect(context: PluginOperationContext | null, contributionId: string): void {
    const installed = this.current(context);
    const contribution = installed?.plugin?.manifest.contributions.find(
      (entry): entry is EffectContribution =>
        entry.kind === 'effect' && entry.id === contributionId,
    );
    if (!installed?.plugin || !contribution) return this.stale();
    const result = this.adoption.adopt(effectContributionCandidate(installed.plugin, contribution));
    const { key, params, error } = adoptionMessage(result, contribution.name);
    this.store.notice.set({ text: this.i18n.t(key, params), error });
  }
}

interface Draft {
  ref: string;
  package: string;
  icon: string;
  text: () => string;
  disabled?: () => boolean;
  action: () => void;
}

/**
 * Turns drafts into commands, naming the package after any label that another
 * entry of the same list shares. Labels are read live (they follow the
 * language), so the comparison is too.
 */
function distinguish(drafts: readonly Draft[]): PluginCommand[] {
  const clash = (draft: Draft): boolean =>
    drafts.some((other) => other !== draft && other.text() === draft.text());
  return drafts.map((draft) => ({
    id: `plugin:${draft.ref}`,
    ref: draft.ref,
    icon: () => draft.icon,
    label: () => (clash(draft) ? `${draft.text()} (${draft.package})` : draft.text()),
    ...(draft.disabled ? { disabled: draft.disabled } : {}),
    action: draft.action,
  }));
}

function packageName(installed: InstalledPlugin): string {
  return installed.plugin?.manifest.name ?? installed.id;
}
