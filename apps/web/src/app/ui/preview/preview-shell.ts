import { Component, computed, inject, input } from '@angular/core';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';

import { DesktopPlatform } from '../../desktop/desktop-platform';
import { isContainedPlacement } from '@shader-studio/shared/surfaces';
import { PREVIEW_MINIMIZED_SIZE } from '@shader-studio/shared/preview-prefs';
import type { ResizeEdge } from '@shader-studio/shared/geometry';
import { COLOR_SCHEME_OPTIONS, Preferences, colorSchemeIcon } from '../../prefs/preferences';
import { ShaderStore } from '../../workspace/shader-store';
import { ShaderCanvas } from '../../rendering/shader-canvas';
import { I18n } from '../../i18n/i18n';
import { TranslatePipe } from '../../i18n/translate.pipe';
import type { TranslationKey } from '../../i18n/keys';
import { ReducedMotion } from '../../prefs/reduced-motion';
import {
  SurfaceGeometryGesture,
  SurfaceLayoutService,
  SurfaceRegistry,
  SurfaceResizeHandles,
  SurfaceTitleBarDirective,
  keyboardResizeFloating,
  projectSurfaceFrame,
} from '../../surfaces';
import { PreviewMenuCommands } from './preview-menu-commands';
import { PreviewWindowControls } from './preview-window-controls';

/**
 * The preview's frame: where it sits, and how you move and size it.
 *
 * The single most important line in this file is the one that renders
 * `<app-shader-canvas>`: there is exactly one, it is never inside an `@if`, and
 * it never moves in the DOM. The stage, a floating window, maximized and
 * collapsed are all *styling* of the frame around it. That is what preserves the
 * WebGL context, the compiled programs, the buffer contents and the shader's
 * clock across every transition — not because we save and restore them, but
 * because nothing is ever torn down to need restoring.
 */

@Component({
  selector: 'app-preview-shell',
  imports: [
    MatDividerModule,
    MatIconModule,
    MatMenuModule,
    PreviewWindowControls,
    SurfaceResizeHandles,
    SurfaceTitleBarDirective,
    ShaderCanvas,
    TranslatePipe,
  ],
  template: `
    @if (windowed()) {
      <div
        class="title-bar"
        surfaceTitleBar
        [dragEnabled]="projected().draggable"
        (dragStart)="onDrag($event)"
        (toggleMaximize)="layout.toggleMaximized(previewId)"
      >
        <mat-icon class="title-icon" aria-hidden="true">blur_on</mat-icon>
        <span class="title">{{ 'preview.title' | translate }}</span>
        <app-preview-window-controls [menu]="previewMenu" />
      </div>
    }

    <div class="body" [class.collapsed]="minimized()" [matContextMenuTriggerFor]="previewMenu">
      <app-shader-canvas />
    </div>

    <mat-menu #previewMenu="matMenu">
      @if (!stageOnly()) {
        <button mat-menu-item type="button" (click)="toggleDetached()">
          <mat-icon>{{ onStage() ? 'open_in_new' : 'wallpaper' }}</mat-icon>
          <span>{{
            (onStage() ? 'action.detachPreview' : 'action.returnToStage') | translate
          }}</span>
        </button>

        @if (windowed()) {
          <button
            mat-menu-item
            type="button"
            [attr.aria-pressed]="maximized()"
            (click)="layout.toggleMaximized(previewId)"
          >
            <mat-icon>{{ maximized() ? 'close_fullscreen' : 'open_in_full' }}</mat-icon>
            <span>{{
              (maximized() ? 'action.restorePreview' : 'action.maximizePreview') | translate
            }}</span>
          </button>
          <button
            mat-menu-item
            type="button"
            [attr.aria-expanded]="!minimized()"
            (click)="layout.toggleMinimized(previewId)"
          >
            <mat-icon>{{ minimized() ? 'expand_less' : 'minimize' }}</mat-icon>
            <span>{{
              (minimized() ? 'action.expandPreview' : 'action.collapsePreview') | translate
            }}</span>
          </button>
          <button mat-menu-item type="button" (click)="layout.resetGeometry(previewId)">
            <mat-icon>aspect_ratio</mat-icon>
            <span>{{ 'action.resetWindow' | translate }}</span>
          </button>
        }

        <mat-divider />
      }

      <button mat-menu-item type="button" (click)="commands.savePng()">
        <mat-icon>photo_camera</mat-icon>
        <span>{{ 'action.savePng' | translate }}</span>
        <span class="hint">S</span>
      </button>
      <button mat-menu-item type="button" (click)="commands.togglePause()">
        <mat-icon>{{ preferences.value().paused ? 'play_arrow' : 'pause' }}</mat-icon>
        <span>{{
          (preferences.value().paused ? 'action.resume' : 'action.pause') | translate
        }}</span>
        <span class="hint">Space</span>
      </button>
      <button
        mat-menu-item
        type="button"
        [disabled]="!store.record()"
        (click)="store.resetParams()"
      >
        <mat-icon>restart_alt</mat-icon>
        <span>{{ 'action.resetParameters' | translate }}</span>
      </button>

      <mat-divider />

      <button mat-menu-item type="button" (click)="commands.toggle('guiVisible')">
        <mat-icon>{{ preferences.value().guiVisible ? 'visibility_off' : 'tune' }}</mat-icon>
        <span>{{
          (preferences.value().guiVisible ? 'action.hideControls' : 'action.showControls')
            | translate
        }}</span>
        <span class="hint">H</span>
      </button>
      <button mat-menu-item type="button" (click)="commands.toggleEditor()">
        <mat-icon>code</mat-icon>
        <span>{{
          (layout.editorOpen() ? 'action.hideEditor' : 'action.showEditor') | translate
        }}</span>
      </button>

      <mat-divider />

      <button mat-menu-item type="button" [matMenuTriggerFor]="themeMenu">
        <mat-icon>{{ themeIcon() }}</mat-icon>
        <span>{{ 'menu.theme' | translate }}</span>
      </button>

      @if (desktop.available) {
        <mat-divider />
        <button mat-menu-item type="button" (click)="desktop.toggleFullscreen()">
          <mat-icon>{{ desktop.fullscreen() ? 'fullscreen_exit' : 'fullscreen' }}</mat-icon>
          <span>{{
            (desktop.fullscreen() ? 'action.exitFullscreen' : 'action.enterFullscreen') | translate
          }}</span>
          <span class="hint">F11</span>
        </button>
      }
    </mat-menu>

    <mat-menu #themeMenu="matMenu">
      @for (option of colorSchemeOptions; track option.value) {
        <button
          mat-menu-item
          type="button"
          [attr.aria-checked]="preferences.value().colorScheme === option.value"
          (click)="commands.setColorScheme(option.value)"
        >
          <mat-icon>{{ option.icon }}</mat-icon>
          <span>{{ commands.themeLabel(option.value) }}</span>
          @if (preferences.value().colorScheme === option.value) {
            <mat-icon class="hint" aria-hidden="true">check</mat-icon>
          }
        </button>
      }
    </mat-menu>

    @if (projected().resizableFloating) {
      <surface-resize-handles
        mode="floating"
        [label]="resizeLabel"
        (pointerDown)="onResizePointer($event)"
        (keyDown)="onResizeKey($event)"
      />
    }
  `,
  styles: `
    :host {
      position: fixed;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: #0a0c10;
    }

    :host(.stage) {
      inset: 0;
      z-index: 0;
    }

    :host(.floating),
    :host(.minimized) {
      border: 1px solid var(--mat-sys-outline-variant);
      border-radius: var(--mat-sys-corner-medium, 8px);
      box-shadow: var(--mat-sys-level4);
    }

    :host(.maximized) {
      border: 1px solid var(--mat-sys-outline-variant);
    }

    :host(.surface-frame--animating) {
      transition: none;
    }

    @media (prefers-reduced-motion: no-preference) {
      :host(.surface-frame--animating) {
        transition: none;
      }
    }

    .title-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 0 0 auto;
      min-height: 34px;
      padding: 2px 5px 2px 8px;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
      background: color-mix(in srgb, var(--mat-sys-surface-container-high) 92%, transparent);
      backdrop-filter: blur(18px);
      color: var(--mat-sys-on-surface);
      font: var(--mat-sys-label-large);
      user-select: none;
      cursor: context-menu;
      touch-action: none;
    }

    .title-bar.surface-title-bar--draggable {
      cursor: move;
    }

    .title-icon {
      flex: 0 0 auto;
      width: 16px;
      height: 16px;
      font-size: 16px;
      color: var(--mat-sys-primary);
    }

    .title {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .body {
      display: flex;
      flex: 1 1 auto;
      min-height: 0;
    }

    .body.collapsed {
      flex: 0 0 0;
      height: 0;
      overflow: hidden;
    }

    app-shader-canvas {
      flex: 1 1 auto;
      min-width: 0;
    }

    .hint {
      margin-left: auto;
      padding-left: 24px;
    }
  `,
  host: {
    '[class.stage]': 'onStage()',
    '[class.floating]': 'floating()',
    '[class.maximized]': 'maximized()',
    '[class.minimized]': 'minimized()',
    '[style.left.px]': 'frame()?.x',
    '[style.top.px]': 'frame()?.y',
    '[style.width.px]': 'frame()?.width',
    '[style.height.px]': 'frameHeight()',
    '[style.z-index]': 'windowZIndex()',
    '[class.surface-frame--dragging]': 'gesture.dragging()',
    '[class.surface-frame--animating]': 'frameAnimating()',
    '(pointerdown)': 'activate()',
    '(focusin)': 'activate()',
    role: 'region',
    'aria-label': 'Shader preview',
  },
})
export class PreviewShell {
  protected readonly layout = inject(SurfaceLayoutService);
  protected readonly registry = inject(SurfaceRegistry);
  protected readonly store = inject(ShaderStore);
  protected readonly preferences = inject(Preferences);
  protected readonly desktop = inject(DesktopPlatform);
  protected readonly i18n = inject(I18n);
  protected readonly commands = inject(PreviewMenuCommands);
  private readonly reducedMotion = inject(ReducedMotion);

  readonly stageOnly = input(false);

  protected readonly previewId = this.layout.previewId;
  protected readonly gesture = new SurfaceGeometryGesture();

  private readonly surface = computed(() => this.layout.preview());

  protected readonly displayMode = computed(() => {
    if (this.stageOnly()) return 'stage' as const;
    const placement = this.surface().placement;
    if (!isContainedPlacement(placement)) return 'stage' as const;
    return placement.mode;
  });

  protected readonly onStage = computed(() => this.displayMode() === 'stage');
  protected readonly floating = computed(() => this.displayMode() === 'floating');
  protected readonly maximized = computed(() => this.displayMode() === 'maximized');
  protected readonly minimized = computed(() => this.displayMode() === 'minimized');
  protected readonly windowed = computed(() => !this.onStage());

  protected readonly projected = computed(() => {
    const workspace = this.layout.previewWorkspace();
    const viewport = { width: workspace.width, height: workspace.height };
    return projectSurfaceFrame(this.surface(), viewport, {
      liveRect: this.gesture.liveRect(),
      livePoint: this.gesture.livePoint(),
      workspaceOrigin: { x: workspace.x, y: workspace.y },
      minimizedSize: PREVIEW_MINIMIZED_SIZE,
    });
  });

  protected readonly frame = computed(() => this.projected().frame);

  protected readonly frameHeight = computed<number | null>(() =>
    this.minimized() ? null : (this.frame()?.height ?? null),
  );

  protected readonly windowZIndex = computed(() =>
    this.projected().stacked ? (this.registry.foreground() === this.previewId ? 4 : 2) : null,
  );

  protected readonly colorSchemeOptions = COLOR_SCHEME_OPTIONS;
  protected readonly themeIcon = computed(() =>
    colorSchemeIcon(this.preferences.value().colorScheme),
  );

  protected readonly frameAnimating = computed(
    () => !this.gesture.dragging() && !this.reducedMotion.enabled(),
  );

  protected onDrag(event: PointerEvent): void {
    const workspace = this.layout.previewWorkspace();
    const viewport = { width: workspace.width, height: workspace.height };
    const placement = this.surface().placement;
    if (!isContainedPlacement(placement)) return;

    if (this.minimized()) {
      const point =
        placement.mode === 'minimized' ? (placement.point ?? { x: 24, y: 24 }) : { x: 24, y: 24 };
      this.gesture.begin(
        event,
        event.currentTarget as HTMLElement,
        {
          gesture: 'move-minimized',
          surfaceKind: 'preview',
          viewport,
          point,
          minimizedSize: PREVIEW_MINIMIZED_SIZE,
        },
        (commit) => {
          if (commit.point) this.layout.commitMinimizedPoint(this.previewId, commit.point);
        },
      );
      return;
    }

    if (placement.mode !== 'floating') return;
    this.gesture.begin(
      event,
      event.currentTarget as HTMLElement,
      {
        gesture: 'move-floating',
        surfaceKind: 'preview',
        viewport,
        rect: placement.rect,
      },
      (commit) => {
        if (commit.rect) this.layout.commitFloatingRect(this.previewId, commit.rect);
      },
    );
  }

  protected onResizePointer(payload: { event: PointerEvent; edge: ResizeEdge }): void {
    const workspace = this.layout.previewWorkspace();
    const viewport = { width: workspace.width, height: workspace.height };
    const placement = this.surface().placement;
    if (!isContainedPlacement(placement) || placement.mode !== 'floating') return;

    this.gesture.begin(
      payload.event,
      payload.event.currentTarget as HTMLElement,
      {
        gesture: 'resize-floating',
        surfaceKind: 'preview',
        viewport,
        rect: placement.rect,
        edge: payload.edge,
      },
      (commit) => {
        if (commit.rect) this.layout.commitFloatingRect(this.previewId, commit.rect);
      },
    );
  }

  protected onResizeKey(payload: { event: KeyboardEvent; edge: ResizeEdge }): void {
    const workspace = this.layout.previewWorkspace();
    const viewport = { width: workspace.width, height: workspace.height };
    const placement = this.surface().placement;
    if (!isContainedPlacement(placement) || placement.mode !== 'floating') return;

    const next = keyboardResizeFloating(
      'preview',
      placement.rect,
      payload.edge,
      payload.event,
      viewport,
    );
    if (!next) return;
    payload.event.preventDefault();
    this.layout.commitFloatingRect(this.previewId, next);
  }

  protected activate(): void {
    if (this.windowed()) this.layout.activate(this.previewId);
  }

  protected toggleDetached(): void {
    if (this.onStage()) {
      this.layout.activate(this.previewId);
      this.layout.float(this.previewId);
    } else {
      this.layout.showOnStage(this.previewId);
    }
  }

  protected readonly resizeLabel = (edge: ResizeEdge): string => {
    const keys: Record<ResizeEdge, TranslationKey> = {
      n: 'preview.edge.n',
      s: 'preview.edge.s',
      e: 'preview.edge.e',
      w: 'preview.edge.w',
      ne: 'preview.edge.ne',
      nw: 'preview.edge.nw',
      se: 'preview.edge.se',
      sw: 'preview.edge.sw',
    };
    return this.i18n.t('preview.resizeEdge', { edge: this.i18n.t(keys[edge]) });
  };
}
