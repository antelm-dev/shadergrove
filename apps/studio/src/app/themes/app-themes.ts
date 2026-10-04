import {
  DOCUMENT,
  Injectable,
  Injector,
  PLATFORM_ID,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

import { DEFAULT_THEME_REFS, type PluginThemeRef } from '@shadergrove/shared/plugin';

import { EditorSettings } from '../editor/editor-settings';
import { toMonacoTheme, type MonacoApi } from '../editor/monaco-loader';
import { PluginInstallations } from '../plugins/plugin-installations';
import { Preferences, colorSchemeIcon } from '../prefs/preferences';
import {
  UI_THEME_PROPERTIES,
  findPluginTheme,
  pairKey,
  pluginThemeEntries,
  resolveAppTheme,
  resolveEditorTheme,
  themePairs,
  uiThemeProperties,
  type PluginThemeEntry,
  type ResolvedAppTheme,
  type ResolvedEditorTheme,
  type ThemePair,
} from './theme-catalog';

/**
 * The one owner of what the app and its editor are painted with.
 *
 * Every theme on offer is a theme contribution of the current profile's active
 * packages — the official Light and Dark too, which the app installs once as a
 * default pack. This resolves the stored choice against them, follows the OS
 * for a paired theme in System mode, and applies the result: the root
 * `color-scheme` and the Material colour tokens for the chrome — overlays,
 * lil-gui and the glass surfaces all derive from those — and Monaco's global
 * theme for every editor. Nothing else writes either; `Preferences` only
 * stores the choices.
 *
 * Until the session and the plugins have loaded — and whenever the chosen
 * theme is not active — the catalogue has no match and the stylesheet's
 * fallback (the house Light/Dark) is painted in the remembered scheme: never a
 * palette of the previous profile, and never one from a package that is no
 * longer active. The stored reference is kept all the while, and applies again
 * as soon as its theme is back. Listing or applying a theme starts no plugin
 * Worker: a theme is data.
 */
@Injectable({ providedIn: 'root' })
export class AppThemes {
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly preferences = inject(Preferences);
  private readonly editorSettings = inject(EditorSettings);
  // The server has no plugins: it renders the built-in theme, deterministically.
  private readonly installations = this.isBrowser ? inject(PluginInstallations) : null;

  private readonly monaco = signal<MonacoApi | null>(null);
  private started = false;

  /** The themes of the current profile's active packages. */
  readonly entries = computed<readonly PluginThemeEntry[]>(() =>
    this.installations ? pluginThemeEntries(this.installations.plugins()) : [],
  );

  /** The light/dark pairs among them, each of which can follow the OS. */
  readonly pairs = computed<readonly ThemePair[]>(() => themePairs(this.entries()));

  /** Whether the chosen theme is worn as it is, or follows the OS within its pair. */
  readonly mode = computed(() => this.preferences.value().appThemeMode);

  /** What the app wears now. */
  readonly app = computed<ResolvedAppTheme>(() =>
    resolveAppTheme(
      this.preferences.value().appThemeId,
      this.preferences.resolved(),
      this.entries(),
      this.mode(),
      this.preferences.systemScheme(),
    ),
  );

  /** The light/dark scheme actually painted. */
  readonly scheme = computed(() => this.app().scheme);

  /** What every editor wears, the settings dialog's preview included. */
  readonly editor = computed<ResolvedEditorTheme>(() =>
    resolveEditorTheme(this.editorSettings.effective().theme, this.app(), this.entries()),
  );

  /** The icon of the theme menu: System's, a paired theme's scheme, or a palette for any other. */
  readonly icon = computed(() => {
    const app = this.app();
    if (app.kind === 'builtin') return colorSchemeIcon(this.preferences.value().colorScheme);
    if (pairKey(app.entry) === null) return 'palette';
    if (this.mode() === 'system') return colorSchemeIcon('system');
    return colorSchemeIcon(app.scheme);
  });

  /** Starts painting. Called once at startup in the browser; a no-op on the server. */
  start(): void {
    if (!this.isBrowser || this.started) return;
    this.started = true;

    const options = { injector: this.injector };
    effect(() => this.applyUi(this.app()), options);

    effect(() => {
      const monaco = this.monaco();
      const theme = this.editor();
      if (monaco) untracked(() => applyEditor(monaco, theme));
    }, options);

    effect(() => this.migrateLegacyChoice(), options);
  }

  /**
   * Hands over Monaco once it has loaded, and paints it at once — before the
   * first editor is created, so no editor ever shows Monaco's default first.
   * Later changes, a plugin palette updated under the same id included, follow
   * through the effect above. Safe to call from every editor.
   */
  attachMonaco(monaco: MonacoApi): void {
    if (untracked(this.monaco) === monaco) return;
    applyEditor(monaco, untracked(this.editor));
    this.monaco.set(monaco);
  }

  /**
   * Wear one theme as it is. Looked up again among the active themes — a menu
   * or palette entry can outlive its package, its profile or its switch — and
   * ignored if it is no longer there. The fallback takes its scheme.
   */
  selectPlugin(ref: PluginThemeRef): void {
    const entry = findPluginTheme(untracked(this.entries), ref);
    if (!entry) return;
    this.preferences.patch({
      appThemeId: ref,
      appThemeMode: 'fixed',
      colorScheme: entry.theme.scheme,
    });
  }

  /** Wear a pair, following the OS between its light and dark theme; ignored if it is gone. */
  selectSystem(key: string): void {
    const pair = untracked(this.pairs).find((candidate) => candidate.key === key);
    if (!pair) return;
    this.preferences.patch({
      appThemeId: pair[untracked(this.preferences.systemScheme)].ref,
      appThemeMode: 'system',
      colorScheme: 'system',
    });
  }

  /** Whether this theme is the one worn now, in either mode. */
  isPluginSelected(ref: PluginThemeRef): boolean {
    const app = this.app();
    return app.kind === 'plugin' && app.entry.ref === ref;
  }

  /** Whether this theme is chosen as it is: the radio state of its row. */
  isFixed(ref: PluginThemeRef): boolean {
    return this.mode() === 'fixed' && this.isPluginSelected(ref);
  }

  /** Whether this pair is worn in System mode. */
  isSystemSelected(key: string): boolean {
    const app = this.app();
    return this.mode() === 'system' && app.kind === 'plugin' && pairKey(app.entry) === key;
  }

  /**
   * Once, the first time the official Light and Dark are both active after the
   * defaults settle: a preference from before themes were packages (`builtin`)
   * becomes the official theme it was showing — System mode for `system`.
   * Never onto a theme that is not there, so a profile without them keeps the
   * fallback and is migrated if they come back; after that, nothing sets
   * `builtin` again.
   */
  private migrateLegacyChoice(): void {
    const installations = this.installations;
    if (!installations?.defaultsSettled() || installations.loading()) return;
    const { appThemeId, colorScheme } = this.preferences.value();
    if (appThemeId !== 'builtin') return;
    const entries = this.entries();
    if (!findPluginTheme(entries, DEFAULT_THEME_REFS.light)) return;
    if (!findPluginTheme(entries, DEFAULT_THEME_REFS.dark)) return;
    const system = colorScheme === 'system';
    const scheme = system ? this.preferences.systemScheme() : colorScheme;
    untracked(() =>
      this.preferences.patch({
        appThemeId: DEFAULT_THEME_REFS[scheme],
        appThemeMode: system ? 'system' : 'fixed',
      }),
    );
  }

  private applyUi(app: ResolvedAppTheme): void {
    const root = this.document.documentElement;
    // Every Material colour token is a `light-dark()` pair, so the built-in
    // palette — and every role a plugin theme leaves out — follows this.
    root.style.colorScheme = app.scheme;
    // Everything the previous theme set goes first, so a theme with fewer roles
    // never keeps a colour of the one before.
    for (const property of UI_THEME_PROPERTIES) root.style.removeProperty(property);
    for (const [property, value] of uiThemeProperties(app)) {
      root.style.setProperty(property, value);
    }
    if (app.kind === 'plugin') root.dataset['appTheme'] = app.entry.ref;
    else delete root.dataset['appTheme'];
  }
}

/** Defines a plugin palette before selecting it; Monaco refreshes a redefined current theme. */
function applyEditor(monaco: MonacoApi, theme: ResolvedEditorTheme): void {
  if (theme.ref) monaco.editor.defineTheme(theme.monacoId, toMonacoTheme(theme.palette));
  monaco.editor.setTheme(theme.monacoId);
}
