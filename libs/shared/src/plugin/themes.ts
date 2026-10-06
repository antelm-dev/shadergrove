/**
 * A `theme` contribution: a named palette for the app's chrome and for the code
 * editor, as plain data. No CSS, selector, URL, font, script or variable name
 * comes from the package — only a closed set of colour *roles*, each an opaque
 * `#RRGGBB`. The host alone decides which CSS token a role paints, so a palette
 * can recolour the studio and nothing else.
 *
 * ```json
 * { "kind": "theme", "id": "amber-dark", "name": "Amber Dark",
 *   "schemaVersion": 1, "scheme": "dark",
 *   "ui": { "background": "#1a1410", ... },
 *   "editor": { "base": "vs-dark", "background": "#1a1410", ..., "tokens": { ... } } }
 * ```
 *
 * `schemaVersion` versions this shape only. Schema 1 is a fixed-scheme theme.
 * Schema 2 (protocol 3 and later) may add `variantGroup`: the light and the dark
 * theme of one package that share it are a pair, which the host's System mode
 * switches between with the OS. A group holds exactly one light and one dark
 * theme of its own package — checked across the whole manifest by
 * `validateThemeGroups` — and names nothing outside it.
 *
 * Also here, under their theme names: the contribution references of `refs`.
 */
import { isRecord } from '../validate/primitives';
import { fail, ok, type Result } from '../validate/result';
import { CONTRIBUTION_ID_PATTERN } from './ids';
import {
  PLUGIN_REF_MAX_LENGTH,
  isPluginContributionRef,
  parsePluginContributionRef,
  pluginContributionRef,
  type PluginContributionRef,
} from './refs';

export const THEME_SCHEMA_VERSION = 2;
/** Schemas this host reads; 2 needs package protocol 3. */
export const THEME_SCHEMA_VERSIONS: readonly number[] = [1, 2];

/** Every theme states its roles for this scheme; the host paints under it. */
export type ThemeScheme = 'light' | 'dark';

/** Roles a theme must define: the surfaces, text and accent every screen uses. */
export const THEME_REQUIRED_UI_ROLES = [
  'background',
  'on-background',
  'surface',
  'on-surface',
  'on-surface-variant',
  'surface-container-lowest',
  'surface-container-low',
  'surface-container',
  'surface-container-high',
  'surface-container-highest',
  'outline',
  'outline-variant',
  'primary',
  'on-primary',
  'primary-container',
  'on-primary-container',
] as const;

/** Roles a theme may define; one left out keeps the built-in value for the theme's scheme. */
export const THEME_OPTIONAL_UI_ROLES = [
  'surface-dim',
  'surface-bright',
  'surface-variant',
  'secondary',
  'on-secondary',
  'secondary-container',
  'on-secondary-container',
  'tertiary',
  'on-tertiary',
  'tertiary-container',
  'on-tertiary-container',
  'inverse-surface',
  'inverse-on-surface',
  'inverse-primary',
  'error',
  'on-error',
  'error-container',
  'on-error-container',
] as const;

export type ThemeRequiredUiRole = (typeof THEME_REQUIRED_UI_ROLES)[number];
export type ThemeOptionalUiRole = (typeof THEME_OPTIONAL_UI_ROLES)[number];
export type ThemeUiRole = ThemeRequiredUiRole | ThemeOptionalUiRole;

export const THEME_UI_ROLES: readonly ThemeUiRole[] = [
  ...THEME_REQUIRED_UI_ROLES,
  ...THEME_OPTIONAL_UI_ROLES,
];

export type ThemeUiPalette = Record<ThemeRequiredUiRole, string> &
  Partial<Record<ThemeOptionalUiRole, string>>;

/** The token colours the editor's GLSL and JSON tokenizers emit. */
export const THEME_EDITOR_TOKENS = [
  'comment',
  'keyword',
  'directive',
  'type',
  'predefined',
  'variable',
  'number',
  'string',
  'operator',
] as const;

export type ThemeEditorToken = (typeof THEME_EDITOR_TOKENS)[number];

/** The editor's palette, in the fields the built-in editor themes use. */
export interface ThemeEditorPalette {
  /** Monaco's base, which must agree with the theme's `scheme`. */
  base: 'vs' | 'vs-dark';
  background: string;
  foreground: string;
  lineHighlight: string;
  lineNumber: string;
  tokens: Record<ThemeEditorToken, string>;
}

export interface ThemeContribution {
  kind: 'theme';
  id: string;
  name: string;
  schemaVersion: 1 | 2;
  scheme: ThemeScheme;
  /** Schema 2: the light/dark pair this theme belongs to, within its package. */
  variantGroup?: string;
  ui: ThemeUiPalette;
  editor: ThemeEditorPalette;
}

const THEME_KEYS = ['kind', 'id', 'name', 'schemaVersion', 'scheme', 'ui', 'editor'];
const THEME_2_KEYS = [...THEME_KEYS, 'variantGroup'];
const EDITOR_KEYS = ['base', 'background', 'foreground', 'lineHighlight', 'lineNumber', 'tokens'];
const EDITOR_COLOURS = ['background', 'foreground', 'lineHighlight', 'lineNumber'] as const;

/** Opaque, six hex digits, nothing else: no names, functions, alpha or `url()`. */
const COLOUR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export function isThemeColour(value: unknown): value is string {
  return typeof value === 'string' && COLOUR_PATTERN.test(value);
}

/**
 * Validate the theme-specific fields of a contribution whose `kind`, `id` and
 * `name` the package validator has already checked. Colours come back lowercase.
 */
export function validateThemeFields(
  input: Record<string, unknown>,
  at: string,
  base: { id: string; name: string },
): Result<ThemeContribution> {
  const schemaVersion = input['schemaVersion'];
  if (schemaVersion !== 1 && schemaVersion !== 2) {
    return fail(
      `${at}.schemaVersion ${String(schemaVersion)} is not supported (this app reads ${THEME_SCHEMA_VERSIONS.join(' and ')})`,
    );
  }
  const known = schemaVersion === 2 ? THEME_2_KEYS : THEME_KEYS;
  const unknownKey = Object.keys(input).find((key) => !known.includes(key));
  if (unknownKey) return fail(`${at}.${unknownKey} is not a known field`);
  const variantGroup = input['variantGroup'];
  if (
    variantGroup !== undefined &&
    (typeof variantGroup !== 'string' || !CONTRIBUTION_ID_PATTERN.test(variantGroup))
  ) {
    return fail(
      `${at}.variantGroup must be lowercase letters, digits and "-", starting with a letter`,
    );
  }
  const scheme = input['scheme'];
  if (scheme !== 'light' && scheme !== 'dark') {
    return fail(`${at}.scheme must be "light" or "dark"`);
  }

  const ui = uiPalette(input['ui'], `${at}.ui`);
  if (!ui.ok) return ui;
  const editor = editorPalette(input['editor'], `${at}.editor`, scheme);
  if (!editor.ok) return editor;

  return ok({
    kind: 'theme',
    ...base,
    schemaVersion,
    scheme,
    ...(variantGroup === undefined ? {} : { variantGroup }),
    ui: ui.value,
    editor: editor.value,
  });
}

/**
 * The manifest-wide rule for variant groups: each one holds exactly one light
 * and one dark theme. Checked once every contribution has validated alone.
 */
export function validateThemeGroups(contributions: readonly { kind: string }[]): Result<true> {
  const groups = new Map<string, ThemeContribution[]>();
  for (const contribution of contributions) {
    if (contribution.kind !== 'theme') continue;
    const theme = contribution as ThemeContribution;
    if (theme.variantGroup === undefined) continue;
    groups.set(theme.variantGroup, [...(groups.get(theme.variantGroup) ?? []), theme]);
  }
  for (const [group, members] of groups) {
    const schemes = members.map((member) => member.scheme).sort();
    if (schemes.length !== 2 || schemes[0] !== 'dark' || schemes[1] !== 'light') {
      return fail(`theme variantGroup "${group}" must hold exactly one light and one dark theme`);
    }
  }
  return ok(true);
}

/** The other theme of a pair, among the themes of the same package; `null` for an unpaired one. */
export function themeVariant<T extends ThemeContribution>(
  themes: readonly T[],
  theme: ThemeContribution,
  scheme: ThemeScheme,
): T | null {
  if (theme.variantGroup === undefined) return null;
  return (
    themes.find((other) => other.variantGroup === theme.variantGroup && other.scheme === scheme) ??
    null
  );
}

function uiPalette(input: unknown, at: string): Result<ThemeUiPalette> {
  if (!isRecord(input)) return fail(`${at} must be an object`);
  const unknownKey = Object.keys(input).find(
    (key) => !(THEME_UI_ROLES as readonly string[]).includes(key),
  );
  if (unknownKey) return fail(`${at}.${unknownKey} is not a known colour role`);

  const palette: Partial<Record<ThemeUiRole, string>> = {};
  for (const role of THEME_UI_ROLES) {
    const value = input[role];
    if (value === undefined) {
      if ((THEME_REQUIRED_UI_ROLES as readonly string[]).includes(role)) {
        return fail(`${at}.${role} is required`);
      }
      continue;
    }
    if (!isThemeColour(value)) return fail(`${at}.${role} must be a colour like #1a2b3c`);
    palette[role] = value.toLowerCase();
  }
  return ok(palette as ThemeUiPalette);
}

function editorPalette(
  input: unknown,
  at: string,
  scheme: ThemeScheme,
): Result<ThemeEditorPalette> {
  if (!isRecord(input)) return fail(`${at} must be an object`);
  const unknownKey = Object.keys(input).find((key) => !EDITOR_KEYS.includes(key));
  if (unknownKey) return fail(`${at}.${unknownKey} is not a known field`);

  const base = input['base'];
  const expected = scheme === 'dark' ? 'vs-dark' : 'vs';
  if (base !== expected) return fail(`${at}.base must be "${expected}" for a ${scheme} theme`);

  const colours: Partial<Record<(typeof EDITOR_COLOURS)[number], string>> = {};
  for (const key of EDITOR_COLOURS) {
    const value = input[key];
    if (!isThemeColour(value)) return fail(`${at}.${key} must be a colour like #1a2b3c`);
    colours[key] = value.toLowerCase();
  }

  const tokensInput = input['tokens'];
  if (!isRecord(tokensInput)) return fail(`${at}.tokens must be an object`);
  const unknownToken = Object.keys(tokensInput).find(
    (key) => !(THEME_EDITOR_TOKENS as readonly string[]).includes(key),
  );
  if (unknownToken) return fail(`${at}.tokens.${unknownToken} is not a known token`);
  const tokens: Partial<Record<ThemeEditorToken, string>> = {};
  for (const token of THEME_EDITOR_TOKENS) {
    const value = tokensInput[token];
    if (!isThemeColour(value)) return fail(`${at}.tokens.${token} must be a colour like #1a2b3c`);
    tokens[token] = value.toLowerCase();
  }

  return ok({
    base: expected,
    ...(colours as Record<(typeof EDITOR_COLOURS)[number], string>),
    tokens: tokens as Record<ThemeEditorToken, string>,
  });
}

// ---------------------------------------------------------------------------
// References — the generic ones of `refs`, under the names themes started with
// ---------------------------------------------------------------------------

/** What a preference stores to name one theme contribution of one package. */
export type PluginThemeRef = PluginContributionRef;
export const PLUGIN_THEME_REF_MAX_LENGTH = PLUGIN_REF_MAX_LENGTH;
export const pluginThemeRef = pluginContributionRef;
export const parsePluginThemeRef = parsePluginContributionRef;
export const isPluginThemeRef: (value: unknown) => value is PluginThemeRef =
  isPluginContributionRef;

// ---------------------------------------------------------------------------
// The app's theme preference
// ---------------------------------------------------------------------------

/**
 * Which palette dresses the app: one plugin theme, by reference. `builtin` is
 * what a preference saved before the default themes became packages still
 * says: the stylesheet's own palette in the remembered scheme. It is also the
 * theme migration's marker — the app maps it once to the official Light/Dark
 * pack, and nothing sets it again.
 */
export type AppThemeId = 'builtin' | PluginThemeRef;

/**
 * `fixed` wears the chosen theme as it is; `system` wears the theme of its
 * pair that matches the OS's light or dark setting. Only a paired theme
 * (`variantGroup`) has a System mode.
 */
export type AppThemeMode = 'fixed' | 'system';

export function sanitizeAppThemeMode(value: unknown): AppThemeMode {
  return value === 'system' ? 'system' : 'fixed';
}

export const DEFAULT_APP_THEME_ID: AppThemeId = 'builtin';

/** A stored value, read back: a well-formed reference survives, anything else is `builtin`. */
export function sanitizeAppThemeId(value: unknown): AppThemeId {
  return isPluginThemeRef(value) ? value : DEFAULT_APP_THEME_ID;
}
