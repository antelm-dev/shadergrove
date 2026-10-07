import { NgComponentOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  untracked,
} from '@angular/core';

import {
  PluginTools,
  type ActiveTool,
  type ToolPanelInputs,
  type ToolSession,
} from './plugin-tools';

interface OutletEntry {
  key: string;
  tool: ActiveTool;
  inputs: ToolPanelInputs;
}

/**
 * The one generic place an Installed card shows a package's tools.
 *
 * It renders the host adapter's panel for each active, registered tool of the
 * package, handing it a `ToolSession`; a package has no say in what is drawn.
 * Nothing renders for a package that is switched off, has no tool with an
 * adapter, or lives in a window that runs no tools. A session belongs to the
 * install it was opened for: an update, a switch-off or a removal closes it
 * (terminating whatever it runs) and a reinstalled package gets a new one.
 *
 * Use: `<app-plugin-tools-outlet [packageId]="installed.id" />` in the card.
 */
@Component({
  selector: 'app-plugin-tools-outlet',
  imports: [NgComponentOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: contents;
    }
    .plugin-tool {
      margin-top: 0.75rem;
    }
  `,
  template: `
    @for (entry of entries(); track entry.tool.ref) {
      <section class="plugin-tool" [attr.data-testid]="'plugin-tool-' + entry.tool.ref">
        <ng-container *ngComponentOutlet="entry.tool.adapter.panel; inputs: entry.inputs" />
      </section>
    }
  `,
})
export class PluginToolsOutlet implements OnDestroy {
  readonly packageId = input.required<string>();

  private readonly tools = inject(PluginTools);
  private readonly sessions = new Map<string, ToolSession>();

  protected readonly entries = computed<readonly OutletEntry[]>(() => {
    const entries: OutletEntry[] = [];
    for (const tool of this.tools.toolsOf(this.packageId())) {
      const key = `${tool.ref}|${tool.installed.plugin!.manifest.version}|${tool.installed.stored.installedAt}`;
      let session = this.sessions.get(key);
      if (!session) {
        session = this.tools.openSession(tool.installed.id, tool.contribution.id) ?? undefined;
        if (!session) continue;
        this.sessions.set(key, session);
      }
      entries.push({ key, tool, inputs: { session } });
    }
    return entries;
  });

  /**
   * A session of an install that is gone stops with it. Closing writes signals,
   * which a `computed` may not, so it is done in an effect; until it runs the
   * session already shows nothing, because its install is no longer the current one.
   */
  constructor() {
    effect(() => {
      const kept = new Set(this.entries().map((entry) => entry.key));
      untracked(() => {
        for (const [key, session] of this.sessions) {
          if (kept.has(key)) continue;
          session.close();
          this.sessions.delete(key);
        }
      });
    });
  }

  ngOnDestroy(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}
