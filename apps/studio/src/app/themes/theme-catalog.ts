import {
  DEFAULT_THEME_REFS,
  THEME_UI_ROLES,
  isPluginThemeRef,
  pluginThemeRef,
  type AppThemeId,
  type AppThemeMode,
  type PluginThemeRef,
  type ThemeContribution,
  type ThemeScheme,
  type ThemeUiRole,
} from '@shadergrove/shared/plugin';
import { isBuiltinEditorThemeId, type EditorThemeId } from '@shadergrove/shared/editor-prefs';

import { findTheme, monacoThemeId, type EditorThemePalette } from '../editor/editor-themes';
import type { InstalledPlugin } from '../plugins/plugin-installations';
import type { ResolvedColorScheme } from '../prefs/preferences';

/**
 * The themes on offer, and what a stored choice turns into.
 *
 * Pure functions of their inputs — the installed packages, the stored ids, the
 * built-in scheme — so the rules are tested without Angular, the DOM or Monaco.
 * `AppThemes` is what feeds them signals and applies the result.
 */

/** One theme contribution of an active package, with the credits the UI shows. */
export interface PluginThemeEntry {
  ref: PluginThemeRef;
  packageId: string;
  packageName: string;
  publisher: string;
  version: string;
  license: string;
  theme: ThemeContribution;
}

/**
 * Every theme of every *active* package — enabled, valid and made for this app
 * version — of the profile whose packages are given. A switched-off, broken or
 * incompatible package contributes nothing, so nothing of it can be applied.
 */
export function pluginThemeEntries(plugins: readonly InstalledPlugin[]): PluginThemeEntry[] {
  const entries: PluginThemeEntry[] = [];
  for (const installed of plugins) {
    const plugin = installed.plugin;
    if (!installed.active || !plugin) continue;
    const { manifest } = plugin;
    for (const contribution of manifest.contributions) {
      if (contribution.kind !== 'theme') continue;
      entries.push({
        ref: pluginThemeRef(manifest.id, contribution.id),
        packageId: manifest.id,
        packageName: manifest.name,
        publisher: manifest.publisher,
        version: manifest.version,
        license: manifest.license,
        theme: contribution,
      });
    }
  }
  return entries;
}

export function findPluginTheme(
  entries: readonly PluginThemeEntry[],
  ref: unknown,
): PluginThemeEntry | null {
  if (!isPluginThemeRef(ref)) return null;
  return entries.find((entry) => entry.ref === ref) ?? null;
}

/**
 * The other theme of a pair: the active theme of the same package and
 * `variantGroup` in `scheme` — itself when it is that scheme — or `null` for a
 * theme that is not paired. Never another package's.
 */
export function themeVariant(
  entries: readonly PluginThemeEntry[],
  entry: PluginThemeEntry,
  scheme: ThemeScheme,
): PluginThemeEntry | null {
  const group = entry.theme.variantGroup;
  if (group === undefined) return null;
  return (
    entries.find(
      (other) =>
        other.packageId === entry.packageId &&
        other.theme.variantGroup === group &&
        other.theme.scheme === scheme,
    ) ?? null
  );
}

/** One light/dark pair of the active themes: what a System mode is offered for. */
export interface ThemePair {
  /** `<packageId>/<variantGroup>`: unique among pairs. */
  key: string;
  light: PluginThemeEntry;
  dark: PluginThemeEntry;
}

/** Every complete pair among the active themes, in the order their light theme comes. */
export function themePairs(entries: readonly PluginThemeEntry[]): ThemePair[] {
  return entries.flatMap((entry) => {
    if (entry.theme.scheme !== 'light') return [];
    const dark = themeVariant(entries, entry, 'dark');
    return dark ? [{ key: pairKey(entry)!, light: entry, dark }] : [];
  });
}

/** The pair a theme belongs to, by key; `null` for an unpaired theme. */
export function pairKey(entry: PluginThemeEntry): string | null {
  const group = entry.theme.variantGroup;
  return group === undefined ? null : `${entry.packageId}/${group}`;
}

// ---------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------

/** What the app wears: a theme of the catalogue, or the stylesheet's fallback palette. */
export type ResolvedAppTheme =
  | { kind: 'builtin'; scheme: ThemeScheme }
  | { kind: 'plugin'; scheme: ThemeScheme; entry: PluginThemeEntry };

/**
 * What the app wears. A theme brings its own scheme; in `system` mode a paired
 * theme gives way to its variant for the OS's scheme (an unpaired one is worn
 * as it is). A reference to a theme that is not in the catalogue (not loaded
 * yet, switched off, removed, another profile's) — or a legacy `builtin` —
 * paints the fallback in the remembered scheme, and the theme applies again as
 * soon as it is back.
 */
export function resolveAppTheme(
  appThemeId: AppThemeId,
  fallbackScheme: ResolvedColorScheme,
  entries: readonly PluginThemeEntry[],
  mode: AppThemeMode = 'fixed',
  systemScheme: ResolvedColorScheme = fallbackScheme,
): ResolvedAppTheme {
  const chosen = appThemeId === 'builtin' ? null : findPluginTheme(entries, appThemeId);
  const entry =
    chosen && mode === 'system' ? (themeVariant(entries, chosen, systemScheme) ?? chosen) : chosen;
  return entry
    ? { kind: 'plugin', scheme: entry.theme.scheme, entry }
    : { kind: 'builtin', scheme: fallbackScheme };
}

/**
 * Which CSS custom property each role paints. The host's mapping, closed: a
 * package names roles, never properties, so it cannot reach any other token.
 */
export const UI_ROLE_PROPERTIES: Readonly<Record<ThemeUiRole, string>> = Object.fromEntries(
  THEME_UI_ROLES.map((role) => [role, `--mat-sys-${role}`]),
) as Record<ThemeUiRole, string>;

/** Every property a theme can set — all of them cleared before the next theme is applied. */
export const UI_THEME_PROPERTIES: readonly string[] = Object.values(UI_ROLE_PROPERTIES);

/** The properties to set for a resolved theme: none for the built-in, whose values are the stylesheet's. */
export function uiThemeProperties(app: ResolvedAppTheme): [property: string, value: string][] {
  if (app.kind === 'builtin') return [];
  const ui = app.entry.theme.ui as Partial<Record<ThemeUiRole, string>>;
  return THEME_UI_ROLES.flatMap((role) => {
    const value = ui[role];
    return value ? [[UI_ROLE_PROPERTIES[role], value] as [string, string]] : [];
  });
}

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

export interface ResolvedEditorTheme {
  /** Monaco's name for it: unique per theme, stable across updates of a package. */
  monacoId: string;
  palette: EditorThemePalette;
  /** Set for a plugin palette, which Monaco does not know until it is defined. */
  ref: PluginThemeRef | null;
}

/**
 * What the editor wears. `auto` follows the app's palette, a plugin theme
 * included; a pinned built-in is taken literally; a pinned plugin theme that is
 * not in the catalogue behaves as `auto` until it is.
 */
export function resolveEditorTheme(
  themeId: EditorThemeId,
  app: ResolvedAppTheme,
  entries: readonly PluginThemeEntry[],
): ResolvedEditorTheme {
  if (isBuiltinEditorThemeId(themeId)) {
    return { monacoId: monacoThemeId(themeId), palette: findTheme(themeId).palette, ref: null };
  }
  const pinned = themeId === 'auto' ? null : findPluginTheme(entries, themeId);
  const entry = pinned ?? (app.kind === 'plugin' ? app.entry : null);
  if (entry) {
    return {
      monacoId: pluginMonacoThemeId(entry.ref),
      palette: entry.theme.editor,
      ref: entry.ref,
    };
  }
  const builtin = app.scheme === 'light' ? 'studio-light' : 'studio-dark';
  return { monacoId: monacoThemeId(builtin), palette: findTheme(builtin).palette, ref: null };
}

/**
 * Monaco only takes `[a-z0-9-]` in a theme name, and a reference holds `:`,
 * `/`, `.` and `_`; hex keeps every reference distinct.
 */
export function pluginMonacoThemeId(ref: PluginThemeRef): string {
  let hex = '';
  for (const char of ref) hex += char.charCodeAt(0).toString(16).padStart(2, '0');
  return `shadergrove-plugin-${hex}`;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * The app's own themes are named in the app's language, like the rest of its
 * menus; any other theme by the name its package gives it.
 */
export function officialThemeKey(ref: PluginThemeRef): 'theme.light' | 'theme.dark' | null {
  if (ref === DEFAULT_THEME_REFS.light) return 'theme.light';
  if (ref === DEFAULT_THEME_REFS.dark) return 'theme.dark';
  return null;
}
