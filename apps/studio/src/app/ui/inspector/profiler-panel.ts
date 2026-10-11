import { Component, Injector, computed, inject } from '@angular/core';

import { Preferences } from '../../prefs/preferences';
import { ProfilerSession } from './profiler-session';
import { ProfilerView } from './profiler-view';

/** The docked bottom panel's Profiler tab: profiles while that tab is the one selected. */
@Component({
  selector: 'app-profiler-panel',
  imports: [ProfilerView],
  template: `<app-profiler-view
    [state]="session.state()"
    (apply)="session.applySuggestion($event)"
  />`,
  styles: `
    :host {
      display: block;
      min-width: 0;
      max-width: 100%;
    }
  `,
})
export class ProfilerPanel {
  private readonly preferences = inject(Preferences);

  protected readonly session = new ProfilerSession(
    computed(() => this.preferences.value().bottomPanelTab === 'profiler'),
    inject(Injector),
  );
}
