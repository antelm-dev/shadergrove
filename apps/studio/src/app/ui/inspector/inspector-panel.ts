import {
  Component,
  ElementRef,
  computed,
  inject,
  input,
  output,
  viewChildren,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';

import { activePostProcessingCount } from '@shadergrove/shared/model';
import { INSPECTOR_TABS, type InspectorTab } from '@shadergrove/shared/panel-prefs';
import { ShaderStore } from '../../workspace/shader-store';
import { GuiPanel } from './gui-panel';
import { InspectorWindowControls } from './inspector-window-controls';
import type { TranslationKey } from '../../i18n/keys';
import { TranslatePipe } from '../../i18n/translate.pipe';
import { PostProcessingPanel } from './post-processing-panel';
import { PresetPanel } from './preset-panel';
import { TexturePanel } from './texture-panel';
import { SurfaceLayoutService } from '../../surfaces';
import { WorkspaceActions } from '../workspace-actions';

const TAB_META: Record<InspectorTab, { icon: string; labelKey: TranslationKey }> = {
  controls: { icon: 'tune', labelKey: 'inspector.controls' },
  textures: { icon: 'image', labelKey: 'inspector.textures' },
  postProcessing: { icon: 'wand_stars', labelKey: 'inspector.postProcessing' },
  presets: { icon: 'bookmarks', labelKey: 'inspector.presets' },
};

/**
 * The inspector: parameters, textures and presets, one at a time.
 *
 * They used to be three panels stacked in a single scrolling column, which meant
 * an empty texture grid and an empty preset list cost you vertical space on every
 * shader that used neither — and that the controls, the thing you actually came
 * to turn, started below the fold. Tabs are what buy that space back.
 *
 * Every panel stays mounted and an inactive one is only `hidden`. That is
 * load-bearing, not a nicety: destroying the view would tear down lil-gui and
 * re-run its build on every tab switch, losing which folders you had open, and
 * would make the texture panel re-resolve four thumbnails each time you came
 * back to it. The same "never tear it down" rule the editor shell lives by.
 *
 * The tab strip is the WAI-ARIA tabs pattern with automatic activation: one tab
 * is in the tab order, the arrow keys, Home and End move between them, and the
 * panel follows focus because every panel is already built. The tabs are
 * icons in a segmented control and the header names the open one, which is
 * what lets four tabs and their counts fit a 260px rail in any language.
 *
 * The strip also carries the counts, so you can see there are two textures
 * bound without opening the tab to find out.
 */
@Component({
  selector: 'app-inspector-panel',
  imports: [
    GuiPanel,
    InspectorWindowControls,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
    PostProcessingPanel,
    PresetPanel,
    TexturePanel,
    TranslatePipe,
  ],
  template: `
    <header
      class="inspector-header"
      [class.draggable]="dragEnabled()"
      (pointerdown)="onHeaderPointerDown($event)"
    >
      <button
        matIconButton
        type="button"
        class="collapse"
        [matTooltip]="'inspector.collapse' | translate"
        [attr.aria-label]="'inspector.collapseAria' | translate"
        (click)="collapse()"
      >
        <mat-icon>chevron_right</mat-icon>
      </button>

      <!-- The open tab's name. The tabs themselves are icons, so four of them
           and their counts fit a 260px rail in any language. -->
      <h2 class="title">{{ label() | translate }}</h2>

      <!-- One action slot, belonging to whichever tab is open. Keeping it here
           rather than inside each panel is what stops the inspector growing a
           third row of headings. -->
      @switch (tab()) {
        @case ('controls') {
          <button
            matIconButton
            type="button"
            [matTooltip]="'inspector.resetTooltip' | translate"
            [attr.aria-label]="'inspector.resetAria' | translate"
            [disabled]="store.controls().length === 0"
            (click)="store.resetParams()"
          >
            <mat-icon>restart_alt</mat-icon>
          </button>
        }
        @case ('presets') {
          <!-- "Save parameter preset", never just "Save": the toolbar's Save
               writes the shader, and the two were previously both called Save. -->
          <button
            matIconButton
            type="button"
            [matTooltip]="'inspector.savePresetTooltip' | translate"
            [attr.aria-label]="'inspector.savePresetAria' | translate"
            [disabled]="!store.record()"
            (click)="workspace.savePreset()"
          >
            <mat-icon>bookmark_add</mat-icon>
          </button>
        }
      }

      <app-inspector-window-controls />
    </header>

    <div class="body" [class.collapsed]="collapsed()">
      <div
        class="tablist"
        role="tablist"
        aria-orientation="horizontal"
        [attr.aria-label]="'inspector.sections' | translate"
        (keydown)="onTabKeydown($event)"
      >
        @for (item of tabs; track item.id) {
          @let selected = tab() === item.id;
          <button
            #tabButton
            type="button"
            role="tab"
            class="tab"
            [id]="'inspector-tab-' + item.id"
            [attr.aria-selected]="selected"
            [attr.aria-controls]="'inspector-panel-' + item.id"
            [attr.aria-label]="item.labelKey | translate"
            [attr.tabindex]="selected ? 0 : -1"
            [matTooltip]="item.labelKey | translate"
            (click)="select(item.id)"
          >
            <mat-icon aria-hidden="true">{{ item.icon }}</mat-icon>
            @if (badges()[item.id]; as badge) {
              <span class="badge">{{ badge }}</span>
            }
          </button>
        }
      </div>

      <div
        class="panel"
        role="tabpanel"
        id="inspector-panel-controls"
        aria-labelledby="inspector-tab-controls"
        [hidden]="tab() !== 'controls'"
      >
        <app-gui-panel />
      </div>
      <div
        class="panel"
        role="tabpanel"
        id="inspector-panel-textures"
        aria-labelledby="inspector-tab-textures"
        [hidden]="tab() !== 'textures'"
      >
        <app-texture-panel />
      </div>
      <div
        class="panel"
        role="tabpanel"
        id="inspector-panel-postProcessing"
        aria-labelledby="inspector-tab-postProcessing"
        [hidden]="tab() !== 'postProcessing'"
      >
        <!-- Loaded right after first render: it and its sliders stay out of the initial bundle. -->
        @defer (on immediate) {
          <app-post-processing-panel />
        }
      </div>
      <div
        class="panel"
        role="tabpanel"
        id="inspector-panel-presets"
        aria-labelledby="inspector-tab-presets"
        [hidden]="tab() !== 'presets'"
      >
        <app-preset-panel />
      </div>
    </div>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
      /* The rail does not scroll — the open tab does. An absolutely positioned
         resize separator on the edge would otherwise scroll away from it. */
      overflow: hidden;
    }

    .inspector-header {
      display: flex;
      align-items: center;
      flex: 0 0 auto;
      gap: 2px;
      padding: 4px 4px 4px 2px;
      user-select: none;
    }

    /* Draggable only while floating — see InspectorShell — mirroring the
       editor toolbar's own drag-region convention. */
    .inspector-header.draggable {
      cursor: move;
    }

    .title {
      flex: 1;
      min-width: 0;
      margin: 0 4px 0 2px;
      overflow: hidden;
      color: var(--mat-sys-on-surface);
      font: var(--mat-sys-title-small);
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .body {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
    }

    /* Minimized: the header (and its window controls) stays visible so the
       inspector can be expanded again; only the tabs and their content collapse. */
    .body.collapsed {
      flex: 0 0 0;
      height: 0;
      overflow: hidden;
      visibility: hidden;
    }

    /* A segmented control: four equal cells in one recessed track. */
    .tablist {
      display: flex;
      flex: 0 0 auto;
      gap: 2px;
      margin: 0 8px 8px;
      padding: 2px;
      border-radius: calc(var(--mat-sys-corner-small) + 2px);
      background: color-mix(in srgb, var(--mat-sys-on-surface) 6%, transparent);
    }

    .tab {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 1 1 0;
      gap: 5px;
      min-width: 0;
      height: 26px;
      padding: 0 4px;
      border: 0;
      border-radius: var(--mat-sys-corner-small);
      background: transparent;
      color: var(--mat-sys-on-surface-variant);
      cursor: pointer;
      transition:
        background-color 140ms ease,
        color 140ms ease;
    }

    .tab:hover {
      color: var(--mat-sys-on-surface);
    }

    .tab:focus-visible {
      outline: 2px solid var(--mat-sys-primary);
      outline-offset: -2px;
    }

    /* The selected cell is raised out of the track rather than tinted: lighter
       than the track in both schemes. */
    .tab[aria-selected='true'] {
      background: light-dark(
        var(--mat-sys-surface-container-lowest),
        var(--mat-sys-surface-container-highest)
      );
      box-shadow: 0 1px 2px rgb(0 0 0 / 22%);
      color: var(--mat-sys-on-surface);
    }

    .tab mat-icon {
      flex: 0 0 auto;
      width: 18px;
      height: 18px;
      font-size: 18px;
    }

    .badge {
      font: 500 10.5px / 1 var(--studio-font-mono);
    }

    .tab[aria-selected='true'] .badge {
      color: var(--mat-sys-primary);
    }

    .panel {
      box-sizing: border-box;
      flex: 1;
      min-height: 0;
      overflow-x: hidden;
      overflow-y: auto;
      padding: 8px 0 4px;
    }

    /* An author rule for the box would otherwise beat the UA's [hidden]. */
    .panel[hidden] {
      display: none;
    }

    /* Keep a short panel stretched to the full height, so its drop targets and
       context menus cover the whole tab. */
    .panel > app-texture-panel,
    .panel > app-preset-panel {
      display: block;
      box-sizing: border-box;
      min-height: 100%;
    }

    /* Under a finger the tabs keep the height Material's tab bar gave them. */
    @media (pointer: coarse) {
      .tab {
        height: 44px;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .tab {
        transition: none;
      }
    }
  `,
})
export class InspectorPanel {
  protected readonly store = inject(ShaderStore);
  protected readonly workspace = inject(WorkspaceActions);

  private readonly layout = inject(SurfaceLayoutService);

  /** Hides the tab content while the surface is minimized; header stays put. */
  readonly collapsed = input(false);
  /** Drag-enabled while floating — see InspectorShell. */
  readonly dragEnabled = input(false);
  readonly dragStart = output<PointerEvent>();

  protected readonly tabs = INSPECTOR_TABS.map((id) => ({ id, ...TAB_META[id] }));
  protected readonly tab = computed<InspectorTab>(() => this.layout.inspectorTab());
  protected readonly label = computed(() => TAB_META[this.tab()].labelKey);

  private readonly tabButtons = viewChildren<ElementRef<HTMLButtonElement>>('tabButton');

  /** How many of the four channels have an image bound. */
  protected readonly boundChannels = computed(
    () => this.store.channels().filter((channel) => channel.ext !== null).length,
  );

  /** How many post-processing effects are actually applied to the frame. */
  protected readonly activeEffects = computed(() => {
    const render = this.store.draft()?.render;
    return render ? activePostProcessingCount(render) : 0;
  });

  /** What each tab's count shows; `null` hides it, as an empty tab has nothing to count. */
  protected readonly badges = computed<Record<InspectorTab, string | null>>(() => {
    const bound = this.boundChannels();
    return {
      controls: count(this.store.controls().length),
      textures: bound ? `${bound}/4` : null,
      postProcessing: count(this.activeEffects()),
      presets: count(this.store.presets().length),
    };
  });

  protected select(tab: InspectorTab): void {
    this.layout.setInspectorTab(tab);
  }

  /** Arrow keys, Home and End move between tabs; the panel follows the focus. */
  protected onTabKeydown(event: KeyboardEvent): void {
    const current = INSPECTOR_TABS.indexOf(this.tab());
    const index = nextTabIndex(event.key, current, INSPECTOR_TABS.length);
    if (index === null) return;

    event.preventDefault();
    this.select(INSPECTOR_TABS[index]);
    this.tabButtons()[index]?.nativeElement.focus();
  }

  protected collapse(): void {
    this.layout.close(this.layout.inspectorId);
  }

  protected onHeaderPointerDown(event: PointerEvent): void {
    if (!this.dragEnabled() || event.button !== 0) return;

    const target = event.target as HTMLElement | null;
    if (target?.closest('button, a, input, [role="menuitem"]')) return;

    this.dragStart.emit(event);
  }
}

function count(value: number): string | null {
  return value > 0 ? String(value) : null;
}

/** The tab a key moves to in a horizontal tab list, or `null` when the key is not ours. */
export function nextTabIndex(key: string, current: number, length: number): number | null {
  switch (key) {
    case 'ArrowRight':
      return (current + 1) % length;
    case 'ArrowLeft':
      return (current - 1 + length) % length;
    case 'Home':
      return 0;
    case 'End':
      return length - 1;
    default:
      return null;
  }
}
