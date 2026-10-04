import { BreakpointObserver, Breakpoints } from '@angular/cdk/layout';
import {
  Component,
  ElementRef,
  PLATFORM_ID,
  afterRenderEffect,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterLink, RouterOutlet } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSidenavContainer, MatSidenavModule } from '@angular/material/sidenav';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { map } from 'rxjs';

import type { ImportMode } from '@shadergrove/shared/model';
import { DEFAULT_PANEL_WIDTHS, PANEL_LIMITS } from '@shadergrove/shared/panel-prefs';
import { Preferences } from './prefs/preferences';
import { AppThemes } from './themes/app-themes';
import { ThemeMenu } from './themes/theme-menu';
import { DesktopAccount } from './desktop/desktop-account';
import { DesktopPlatform } from './desktop/desktop-platform';
import { DesktopSync } from './desktop/desktop-sync';
import { ExploreAccess } from './publications/explore-access';
import { ShaderStore } from './workspace/shader-store';
import { SurfaceLayoutService } from './surfaces/surface-layout';
import { SurfaceRegistry } from './surfaces/surface-registry';
import { EditorShell } from './ui/editor/editor-shell';
import { BottomPanel } from './ui/bottom-panel/bottom-panel';
import { AppTitlebar } from './ui/layout/app-titlebar';
import { DocumentStatus } from './ui/editor/document-status';
import { GlobalShortcuts } from './ui/layout/global-shortcuts';
import { InspectorShell } from './ui/inspector/inspector-shell';
import { CommandPalette, type CommandPaletteData } from './ui/command-palette/command-palette';
import { MenuCommands, type MenuCommand } from './ui/menu-commands';
import { isOutputWindow } from './output-mode';
import { PreviewShell } from './ui/preview/preview-shell';
import { PreviewStage } from './ui/preview/preview-stage';
import { ResizeHandle } from './ui/layout/resize-handle';
import { ShaderBrowser } from './ui/browser/shader-browser';
import { TransportBar } from './ui/layout/transport-bar';
import { StartupCoordinator } from './workspace/startup-coordinator';
import { WorkspaceActions } from './ui/workspace-actions';
import { PluginCommands } from './plugins/plugin-commands';
import { FALLBACK_LANGUAGE_ID } from '@shadergrove/shared/plugin';
import { I18n } from './i18n/i18n';
import { TranslatePipe } from './i18n/translate.pipe';
import { AuthService } from './auth/auth.service';
import { AuthPrompt } from './auth/auth-prompt';
import { AccountDialog } from './ui/dialogs/account-dialog';
import { AuthDialog, type AuthDialogData } from './ui/dialogs/auth-dialog';

/** Height of the strip at the top of the window that reveals zen mode's exit button. */
const ZEN_EDGE_PX = 48;

@Component({
  selector: 'app-root',
  hostDirectives: [GlobalShortcuts],
  imports: [
    AppTitlebar,
    BottomPanel,
    EditorShell,
    InspectorShell,
    ThemeMenu,
    TranslatePipe,
    MatButtonModule,
    MatDialogModule,
    MatDividerModule,
    MatIconModule,
    MatMenuModule,
    MatProgressBarModule,
    MatSidenavModule,
    MatToolbarModule,
    MatTooltipModule,
    PreviewShell,
    PreviewStage,
    ResizeHandle,
    RouterLink,
    RouterOutlet,
    ShaderBrowser,
    TransportBar,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly store = inject(ShaderStore);
  protected readonly sync = inject(DesktopSync);
  protected readonly preferences = inject(Preferences);
  protected readonly themes = inject(AppThemes);
  protected readonly workspace = inject(WorkspaceActions);
  private readonly pluginCommands = inject(PluginCommands);
  protected readonly desktop = inject(DesktopPlatform);
  protected readonly status = inject(DocumentStatus);
  protected readonly commands = inject(MenuCommands);
  protected readonly layout = inject(SurfaceLayoutService);
  private readonly surfaces = inject(SurfaceRegistry);
  protected readonly i18n = inject(I18n);
  protected readonly outputMode = isOutputWindow();

  protected readonly auth = inject(AuthService);
  private readonly authPrompt = inject(AuthPrompt);
  /** What the server offers: no Explore button, and no Moderation entry, unless it says so. */
  protected readonly explore = inject(ExploreAccess).capabilities;

  /**
   * Cloud accounts exist on the web and nowhere else. The desktop app stores
   * everything locally for one user, so it shows no account controls at all
   * rather than controls that cannot lead anywhere.
   */
  protected readonly cloudAccounts = !this.desktop.available;
  /** The desktop's own account, signed in through the browser when the build has a server. */
  protected readonly desktopAccount = inject(DesktopAccount);
  protected readonly desktopAccountShown = computed(() => {
    const state = this.desktopAccount.state();
    return this.cloudAccounts || state.status === 'disabled' ? null : state;
  });

  private readonly snackBar = inject(MatSnackBar);
  private readonly dialog = inject(MatDialog);
  /** At most one auth dialog, however many 401s arrive at once. */
  private authDialogOpen = false;

  private readonly fileInput = viewChild.required<ElementRef<HTMLInputElement>>('fileInput');
  private readonly importMode = signal<ImportMode>('rename');

  protected readonly isHandset = toSignal(
    inject(BreakpointObserver)
      .observe([Breakpoints.Handset, Breakpoints.TabletPortrait])
      .pipe(map((state) => state.matches)),
    { initialValue: false },
  );

  /**
   * On a handset the drawer covers the whole screen, so it starts closed and is
   * not remembered — the saved `browserOpen` preference describes the desktop
   * rail, where an open drawer costs nothing.
   */
  private readonly handsetDrawerOpen = signal(false);

  protected readonly drawerOpen = computed(() =>
    this.isHandset() ? this.handsetDrawerOpen() : this.preferences.value().browserOpen,
  );

  protected readonly fallbackLanguage = FALLBACK_LANGUAGE_ID;

  protected readonly inspectorOpen = computed(() => this.layout.inspectorOpen());

  /** Whether the pointer is in the strip along the top edge that reveals zen mode's exit. */
  protected readonly zenExitNear = signal(false);

  // --- Menus --------------------------------------------------------------
  // One section of the "More actions" menu each. The items that are not plain
  // icon-label-verb rows — the Theme submenu, the desktop-only output window —
  // stay written out in the template, where their exceptions are visible.

  private readonly toggleInspector: MenuCommand = {
    id: 'toggle-inspector',
    icon: () => 'tune',
    label: () =>
      this.i18n.t(this.inspectorOpen() ? 'action.hideInspector' : 'action.showInspector'),
    shortcut: 'H',
    action: () => this.layout.toggleInspectorOpen(),
  };

  private readonly captureImage: MenuCommand = {
    id: 'capture-image',
    icon: () => 'photo_camera',
    label: () => this.i18n.t('action.captureImage'),
    disabled: () => !this.store.record(),
    shortcut: 'S',
    action: () => this.commands.captureImage(),
  };

  protected readonly viewCommands: readonly MenuCommand[] = [
    this.toggleInspector,
    this.commands.toggleEditor,
    this.commands.togglePanel,
    this.commands.zenMode,
    this.captureImage,
    this.commands.exportSequence,
  ];

  /**
   * The same commands as the top of `viewCommands`, rendered a second way: as
   * inline toolbar buttons for when there is room, so the single most-used
   * toggles do not cost a trip through "More actions". `exportSequence` opens
   * a dialog rather than acting immediately, so — like Save — it is left out.
   */
  protected readonly quickActions: readonly MenuCommand[] = [
    this.toggleInspector,
    this.commands.toggleEditor,
    this.commands.togglePanel,
    this.captureImage,
  ];

  protected readonly editorOpen = this.layout.editorOpen;
  protected readonly bottomPanelOpen = computed(() => this.preferences.value().bottomPanelOpen);

  /**
   * The preview lives beside the application shell, while the editor lives
   * inside it. Give the shell its own root-level layer so an active editor can
   * genuinely overtake a floating preview instead of being trapped below the
   * preview's stacking context.
   */
  protected readonly shellZIndex = computed(() =>
    this.surfaces.foreground() === this.layout.editorId ? 3 : 1,
  );

  /**
   * Whether a quick action's target panel is currently open — `capture-image`
   * has no on/off state and simply falls through to `false`.
   */
  protected isQuickActionActive(id: string): boolean {
    switch (id) {
      case 'toggle-inspector':
        return this.inspectorOpen();
      case 'toggle-editor':
        return this.editorOpen();
      case 'toggle-panel':
        return this.bottomPanelOpen();
      default:
        return false;
    }
  }

  protected openSignIn(): void {
    this.openAuth({ mode: 'sign-in' });
  }

  protected openAccount(): void {
    this.dialog.open(AccountDialog, {
      autoFocus: 'dialog',
      restoreFocus: true,
      maxWidth: 'calc(100vw - 32px)',
    });
  }

  protected async signOut(): Promise<void> {
    const result = await this.workspace.signOut();
    if (result && !result.ok) {
      this.store.notice.set({
        text: result.message ?? this.i18n.t('auth.genericError'),
        error: true,
      });
    }
  }

  protected async desktopSignIn(): Promise<void> {
    const result = await this.desktopAccount.signIn();
    if (result === 'ok' || result === 'cancelled') return;
    const key =
      result === 'timeout'
        ? 'account.signInTimeout'
        : result === 'encryption-unavailable'
          ? 'account.encryptionUnavailable'
          : 'account.signInFailed';
    this.store.notice.set({ text: this.i18n.t(key), error: true });
  }

  /**
   * The editor keeps its document throughout: signing in happens *over* the
   * app, so an expired session costs a dialog rather than unsaved work.
   */
  private openAuth(data: AuthDialogData): void {
    if (this.authDialogOpen) return;
    this.authDialogOpen = true;
    this.dialog
      .open(AuthDialog, {
        data,
        autoFocus: 'first-tabbable',
        restoreFocus: true,
        maxWidth: 'calc(100vw - 32px)',
      })
      .afterClosed()
      .subscribe(() => {
        this.authDialogOpen = false;
        this.authPrompt.clear();
      });
  }

  protected readonly shaderCommands: readonly MenuCommand[] = [
    this.commands.newShader,
    this.commands.renameShader,
    this.commands.duplicateShader,
  ];

  /**
   * The file commands, with what the active plugins add in between: their
   * importers after the app's own, their exporters after Export shader. A
   * plugin that is missing or switched off adds nothing.
   */
  protected readonly importExportCommands = computed<readonly MenuCommand[]>(() => [
    this.commands.import('rename', 'action.importShader'),
    this.commands.import('overwrite', 'action.importReplace'),
    ...this.pluginCommands.imports(),
    this.commands.exportShader,
    ...this.pluginCommands.exports(),
    this.commands.exportAll,
  ]);

  private readonly deleteShader: MenuCommand = {
    id: 'delete-shader',
    icon: () => 'delete',
    label: () => this.i18n.t('action.deleteShader'),
    disabled: () => !this.store.record(),
    action: () => this.commands.deleteCurrent(),
  };

  /** The context menu on the document title. It only opens over a shader. */
  protected readonly documentCommands = computed<readonly MenuCommand[]>(() => [
    this.commands.renameShader,
    this.commands.duplicateShader,
    this.commands.exportShader,
    ...this.pluginCommands.exports(),
    this.deleteShader,
  ]);

  /** What the Settings section keeps behind submenus and dialogs, flattened for the palette. */
  private readonly settingsCommands: readonly MenuCommand[] = [
    {
      id: 'editor-appearance',
      icon: () => 'settings',
      label: () => this.i18n.t('menu.editorAppearance'),
      action: () => void this.workspace.openEditorSettings(),
    },
    {
      id: 'keyboard-shortcuts',
      icon: () => 'keyboard',
      label: () => this.i18n.t('menu.keyboardShortcuts'),
      action: () => void this.workspace.openKeyboardShortcuts(),
    },
  ];

  /**
   * The command palette: the menus' own commands under the menus' own headings,
   * and the shader list.
   *
   * Deliberately not lazy-loaded. Ctrl+K is followed by typing at once, and
   * every key pressed while a chunk was still arriving would land on the page
   * instead — where S captures an image and H hides the inspector.
   *
   * Never over another dialog, itself included: a modal is a question that has
   * to be answered first, and the export dialog in particular stays open while
   * a capture is running — no time to switch shader from underneath it.
   */
  protected openPalette(): void {
    if (this.dialog.openDialogs.length > 0) return;

    const data: CommandPaletteData = {
      groups: [
        { label: this.i18n.t('menu.view'), commands: this.viewCommands },
        {
          label: this.i18n.t('menu.shader'),
          commands: [...this.shaderCommands, this.deleteShader, ...this.pluginCommands.effects()],
        },
        { label: this.i18n.t('menu.importExport'), commands: this.importExportCommands() },
        {
          label: this.i18n.t('menu.settings'),
          commands: [
            ...this.pluginCommands.themeCommands(),
            ...this.pluginCommands.languageCommands(),
            ...this.settingsCommands,
          ],
        },
      ],
    };

    this.dialog.open(CommandPalette, {
      data,
      ariaLabel: this.i18n.t('palette.title'),
      autoFocus: 'input',
      // Focus at once, not after the open animation: the next key pressed
      // is the first letter of what is being searched for.
      delayFocusTrap: false,
      restoreFocus: true,
      width: '560px',
      maxWidth: 'calc(100vw - 32px)',
      position: { top: '12vh' },
    });
  }

  // --- Panel widths -------------------------------------------------------

  protected readonly panelLimits = PANEL_LIMITS;
  protected readonly defaultWidths = DEFAULT_PANEL_WIDTHS;

  /**
   * The width a separator is currently being dragged to, if one is.
   *
   * While it is set the panel renders from here instead of from `Preferences`,
   * which is only written once the gesture ends — see `ResizeHandle`.
   */
  protected readonly liveBrowserWidth = signal<number | null>(null);

  protected readonly browserWidth = computed(
    () => this.liveBrowserWidth() ?? this.preferences.value().browserWidth,
  );

  private readonly sidenavContainer = viewChild.required(MatSidenavContainer);

  constructor() {
    // Constructing this kicks off the whole boot sequence — see its own
    // constructor. Nothing here needs to call anything on it.
    inject(StartupCoordinator);

    // The hidden input the browser imports go through is in this template.
    if (!this.outputMode) {
      this.commands.useFilePicker((mode) => this.pickFile(mode));
      this.commands.usePalette(() => this.openPalette());
    }

    // Resolving the session in the browser only. Doing it during SSR would put
    // one visitor's identity into a response that may be cached and handed to
    // the next, so the shell renders anonymous and settles on hydration.
    if (this.cloudAccounts && !this.outputMode && isPlatformBrowser(inject(PLATFORM_ID))) {
      void this.auth.refresh();
    }

    // A `401`, or a link out of a verification or reset email, asks for the
    // dialog through this signal rather than opening one itself — so a burst of
    // parallel failures still produces exactly one.
    effect(() => {
      const pending = this.authPrompt.pending();
      if (pending) this.openAuth(pending);
    });

    /**
     * A side drawer offsets the content with a margin that Material measures for
     * itself — on open, on close, and on a viewport change, but *not* when the
     * drawer's own width changes underneath it. Dragging the separator is exactly
     * that case, so it has to be asked.
     *
     * It has to be asked *after* the frame is rendered, which is why this is an
     * `afterRenderEffect` and not an `effect`. `updateContentMargins` does not
     * take a width — it measures the drawer's `offsetWidth` off the DOM. A plain
     * effect runs before Angular has flushed the `[style.width.px]` binding, so
     * Material would measure the width the drawer had *before* the drag and the
     * content would settle one gesture behind: the drawer grows, the content
     * stays put and is overlapped by it, and the separator — which is pinned to
     * the content's left edge — is left stranded inside the drawer, where it can
     * no longer be grabbed. You get exactly one resize.
     */
    afterRenderEffect(() => {
      if (this.outputMode) return;
      this.browserWidth();
      this.drawerOpen();
      this.sidenavContainer().updateContentMargins();
    });

    // Picking a shader on a handset should get the drawer out of the way — it
    // is covering the very thing you just chose to look at.
    effect(() => {
      this.store.selectedId();
      untracked(() => {
        if (this.isHandset()) this.handsetDrawerOpen.set(false);
      });
    });

    // Zen mode's exit button shows while the pointer is in the top strip. The
    // listeners exist only while zen is on and are attached by hand, so an
    // ordinary pointer move costs the app nothing.
    effect((onCleanup) => {
      if (!this.commands.zen()) {
        this.zenExitNear.set(false);
        return;
      }
      const track = (event: PointerEvent) => this.zenExitNear.set(event.clientY < ZEN_EDGE_PX);
      window.addEventListener('pointermove', track);
      window.addEventListener('pointerdown', track);
      onCleanup(() => {
        window.removeEventListener('pointermove', track);
        window.removeEventListener('pointerdown', track);
      });
    });

    effect(() => {
      const notice = this.store.notice();
      if (!notice) return;

      this.snackBar.open(notice.text, this.i18n.t('action.dismiss'), {
        duration: notice.error ? 8000 : 3000,
        politeness: notice.error ? 'assertive' : 'polite',
      });
      this.store.notice.set(null);
    });
  }

  protected commitBrowserWidth(width: number): void {
    this.liveBrowserWidth.set(null);
    this.preferences.patch({ browserWidth: width });
  }

  protected toggleBrowser(): void {
    if (this.isHandset()) {
      this.handsetDrawerOpen.update((open) => !open);
    } else {
      this.preferences.patch({ browserOpen: !this.preferences.value().browserOpen });
    }
  }

  protected closeBrowser(): void {
    if (this.isHandset()) {
      this.handsetDrawerOpen.set(false);
    } else {
      this.preferences.patch({ browserOpen: false });
    }
  }

  /** The browser half of an import: the desktop opens its own dialog instead. */
  private pickFile(mode: ImportMode): void {
    this.importMode.set(mode);
    const input = this.fileInput().nativeElement;
    // Reset first, so picking the same file twice still fires a change event.
    input.value = '';
    input.click();
  }

  protected async onFilePicked(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) await this.workspace.importFile(file, this.importMode());
  }

  /**
   * What the document error badge is *for*: it exposes Problems, not the
   * source editor — clicking a specific diagnostic there is what opens the
   * editor, via `EditorWindow.openEditor()`.
   */
  protected openProblems(): void {
    this.preferences.patch({ bottomPanelOpen: true, bottomPanelTab: 'problems' });
  }
}
