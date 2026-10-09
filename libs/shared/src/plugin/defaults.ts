/**
 * The default packages: official, data-only packs the app installs switched on,
 * once per plugin profile, and from then on treats like any other package —
 * the user can switch them off, remove them and reinstall them.
 *
 * This list is the app's, and it is the only thing that can make a package a
 * default: nothing in a package or a catalogue entry grants itself that. Each
 * one holds themes or languages only — no code, GLSL or URL — and is installed
 * from this release's own catalogue, checked against its size and hash.
 */
import type { PluginPackage } from './package';
import { pluginContributionRef, type PluginContributionRef } from './refs';

/**
 * Bumped when the list changes. A profile seeded for an older version gets
 * what was added since, and nothing it already had back.
 */
export const DEFAULT_PACKAGES_VERSION = 1;

export const DEFAULT_THEMES_PACKAGE_ID = 'dev.shadergrove.default-themes';
export const ENGLISH_PACKAGE_ID = 'dev.shadergrove.language-en';
export const FRENCH_PACKAGE_ID = 'dev.shadergrove.language-fr';

export const DEFAULT_PACKAGE_IDS: readonly string[] = [
  DEFAULT_THEMES_PACKAGE_ID,
  ENGLISH_PACKAGE_ID,
  FRENCH_PACKAGE_ID,
];

export function isDefaultPackageId(id: string): boolean {
  return DEFAULT_PACKAGE_IDS.includes(id);
}

/**
 * Whether a package is data and nothing else — themes and languages, no code
 * and no GLSL. The only kind the app installs by itself, and the only kind a
 * window that manages no plugins (the output and satellite windows) may read.
 */
export function isDataOnlyPackage(plugin: PluginPackage): boolean {
  return (
    plugin.code === undefined &&
    Object.keys(plugin.glsl).length === 0 &&
    Object.keys(plugin.templates).length === 0 &&
    plugin.manifest.contributions.every(({ kind }) => kind === 'theme' || kind === 'language')
  );
}

/** The official Light and Dark themes: one pair, `default`. */
export const DEFAULT_THEME_REFS = {
  light: pluginContributionRef(DEFAULT_THEMES_PACKAGE_ID, 'light'),
  dark: pluginContributionRef(DEFAULT_THEMES_PACKAGE_ID, 'dark'),
} as const satisfies Record<'light' | 'dark', PluginContributionRef>;

/** The official languages, by the legacy locale a preference may still hold. */
export const DEFAULT_LANGUAGE_REFS = {
  en: pluginContributionRef(ENGLISH_PACKAGE_ID, 'english'),
  fr: pluginContributionRef(FRENCH_PACKAGE_ID, 'french'),
} as const satisfies Record<'en' | 'fr', PluginContributionRef>;

// ---------------------------------------------------------------------------
// What a plugin profile remembers of them
// ---------------------------------------------------------------------------

/**
 * Per default package: `seeded` once it was installed (or found installed),
 * `removed` once the user removed it — written *before* the package is
 * deleted, so an interrupted seed can never bring it back. A package with
 * neither is still to be seeded.
 */
export type DefaultPackageState = 'seeded' | 'removed';

/**
 * Host-owned metadata kept beside a profile's installed packages — never as a
 * package record. `version` is the `DEFAULT_PACKAGES_VERSION` it was last
 * written under.
 */
export interface PluginBootstrapState {
  version: number;
  packages: Record<string, DefaultPackageState>;
}

export const PLUGIN_BOOTSTRAP_MAX_BYTES = 16 * 1024;

export function emptyBootstrapState(): PluginBootstrapState {
  return { version: 0, packages: {} };
}

/**
 * A stored state read back, keeping only what is well formed — entries for
 * the default packages, in one of the two states. Anything else reads as
 * empty, which can only seed what is missing: it never replaces or re-enables
 * a package that is installed.
 */
export function sanitizeBootstrapState(value: unknown): PluginBootstrapState {
  const state = emptyBootstrapState();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return state;
  const { version, packages } = value as Record<string, unknown>;
  if (Number.isInteger(version) && (version as number) >= 0) state.version = version as number;
  if (typeof packages !== 'object' || packages === null || Array.isArray(packages)) return state;
  for (const id of DEFAULT_PACKAGE_IDS) {
    const entry = Object.hasOwn(packages, id) ? (packages as Record<string, unknown>)[id] : null;
    if (entry === 'seeded' || entry === 'removed') state.packages[id] = entry;
  }
  return state;
}
