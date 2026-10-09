import { describe, expect, it } from 'vitest';

import { PLUGIN_LIMITS, isCodeContribution, validatePluginPackage } from './package';
import {
  PLUGIN_THEME_REF_MAX_LENGTH,
  THEME_OPTIONAL_UI_ROLES,
  THEME_REQUIRED_UI_ROLES,
  isPluginThemeRef,
  parsePluginThemeRef,
  pluginThemeRef,
  sanitizeAppThemeId,
  sanitizeAppThemeMode,
  themeVariant,
  type ThemeContribution,
} from './themes';

const ui = Object.fromEntries(THEME_REQUIRED_UI_ROLES.map((role) => [role, '#20242A']));

const editor = {
  base: 'vs-dark',
  background: '#101010',
  foreground: '#EEEEEE',
  lineHighlight: '#202020',
  lineNumber: '#606060',
  tokens: {
    comment: '#707070',
    keyword: '#ff8800',
    directive: '#ffaa00',
    type: '#88ccff',
    predefined: '#99ddaa',
    variable: '#ffdd66',
    number: '#ffbb77',
    string: '#bbee88',
    operator: '#dddddd',
  },
};

const dark = {
  kind: 'theme',
  id: 'amber-dark',
  name: 'Amber Dark',
  schemaVersion: 1,
  scheme: 'dark',
  ui,
  editor,
};
const light = {
  ...dark,
  id: 'amber-light',
  name: 'Amber Light',
  scheme: 'light',
  editor: { ...editor, base: 'vs' },
};

function themes(contributions: unknown[], extra: Record<string, unknown> = {}) {
  return {
    manifest: {
      id: 'dev.example.themes',
      version: '1.0.0',
      protocolVersion: 1,
      appVersionRange: '>=1.4.0 <2.0.0',
      name: 'Themes',
      publisher: 'Example',
      license: 'CC0-1.0',
      contributions,
    },
    ...extra,
  };
}

const errors = (input: unknown) => {
  const result = validatePluginPackage(input);
  return result.ok ? [] : result.errors;
};
const withTheme = (patch: Record<string, unknown>) => themes([{ ...dark, ...patch }]);

describe('theme contributions', () => {
  it('accepts a package of two themes with no code, lowercasing every colour', () => {
    const result = validatePluginPackage(themes([dark, light]));
    if (!result.ok) throw new Error(result.errors.join());
    const [first, second] = result.value.manifest.contributions as ThemeContribution[];
    expect(result.value.code).toBeUndefined();
    expect(result.value.glsl).toEqual({});
    expect(first).toMatchObject({ kind: 'theme', scheme: 'dark', schemaVersion: 1 });
    expect(first!.ui.background).toBe('#20242a');
    expect(first!.editor.foreground).toBe('#eeeeee');
    expect(second).toMatchObject({ scheme: 'light', editor: { base: 'vs' } });
    expect(result.value.manifest.contributions.some(isCodeContribution)).toBe(false);
  });

  it('accepts every optional role, and keeps out the ones left unset', () => {
    const full = Object.fromEntries(THEME_OPTIONAL_UI_ROLES.map((role) => [role, '#123456']));
    const result = validatePluginPackage(withTheme({ ui: { ...ui, ...full } }));
    if (!result.ok) throw new Error(result.errors.join());
    expect((result.value.manifest.contributions[0] as ThemeContribution).ui.error).toBe('#123456');

    const partial = validatePluginPackage(themes([dark]));
    if (!partial.ok) throw new Error(partial.errors.join());
    expect('error' in (partial.value.manifest.contributions[0] as ThemeContribution).ui).toBe(
      false,
    );
  });

  it('refuses code in a package that is only declarative', () => {
    expect(errors(themes([dark], { code: 'x' }))[0]).toMatch(/code is only for/);
  });

  it('keeps a mixed package valid, with the code its importer needs', () => {
    const importer = {
      kind: 'importer',
      id: 'import',
      name: 'Import',
      extensions: ['.txt'],
      maxInputBytes: 10,
      maxOutputBytes: 10,
    };
    expect(validatePluginPackage(themes([dark, importer], { code: 'x' })).ok).toBe(true);
    expect(errors(themes([dark, importer]))[0]).toMatch(/code is required/);
  });

  it('refuses a missing or unknown role, field or token', () => {
    const { primary: _primary, ...noPrimary } = ui;
    expect(errors(withTheme({ ui: noPrimary }))[0]).toMatch(/ui\.primary is required/);
    expect(errors(withTheme({ ui: { ...ui, 'panel-glow': '#000000' } }))[0]).toMatch(
      /panel-glow is not a known colour role/,
    );
    expect(errors(withTheme({ css: 'body{}' }))[0]).toMatch(/css is not a known field/);
    expect(errors(withTheme({ editor: { ...editor, font: 'Comic' } }))[0]).toMatch(/font/);
    expect(
      errors(
        withTheme({ editor: { ...editor, tokens: { ...editor.tokens, regexp: '#000000' } } }),
      )[0],
    ).toMatch(/regexp/);
    const { string: _string, ...noString } = editor.tokens;
    expect(errors(withTheme({ editor: { ...editor, tokens: noString } }))[0]).toMatch(
      /tokens\.string/,
    );
  });

  it('refuses anything but an opaque #RRGGBB colour', () => {
    for (const colour of [
      'red',
      '#fff',
      '#11223344',
      'rgb(0,0,0)',
      'url(https://x)',
      '#12345g',
      ' #123456',
      'var(--x)',
      12,
    ]) {
      expect(errors(withTheme({ ui: { ...ui, surface: colour } }))[0]).toMatch(/ui\.surface/);
      expect(errors(withTheme({ editor: { ...editor, background: colour } }))[0]).toMatch(
        /editor\.background/,
      );
    }
  });

  it('refuses a base that contradicts the scheme, and an unknown scheme or version', () => {
    expect(errors(withTheme({ editor: { ...editor, base: 'vs' } }))[0]).toMatch(/"vs-dark"/);
    expect(errors(withTheme({ scheme: 'light' }))[0]).toMatch(/"vs" for a light/);
    expect(errors(withTheme({ editor: { ...editor, base: 'hc-black' } }))[0]).toMatch(/base/);
    expect(errors(withTheme({ scheme: 'sepia' }))[0]).toMatch(/scheme/);
    expect(errors(withTheme({ schemaVersion: 2 }))[0]).toMatch(/schemaVersion 2/);
    expect(errors(withTheme({ schemaVersion: undefined }))[0]).toMatch(/schemaVersion/);
  });

  it('refuses bad ids, names, duplicates and non-object palettes', () => {
    expect(errors(withTheme({ id: 'Amber' }))[0]).toMatch(/id/);
    expect(errors(withTheme({ name: '' }))[0]).toMatch(/name/);
    expect(errors(themes([dark, dark]))[0]).toMatch(/duplicated/);
    expect(errors(withTheme({ ui: [] }))[0]).toMatch(/ui must be an object/);
    expect(errors(withTheme({ editor: null }))[0]).toMatch(/editor must be an object/);
  });

  it('keeps the contribution count and manifest size quotas', () => {
    const many = Array.from({ length: PLUGIN_LIMITS.contributionCount + 1 }, (_, i) => ({
      ...dark,
      id: `t${i}`,
    }));
    expect(errors(themes(many))[0]).toMatch(/at most 32/);
    const most = many.slice(0, PLUGIN_LIMITS.contributionCount);
    expect(validatePluginPackage(themes(most)).ok).toBe(true);
  });

  it('refuses the kind under an older protocol, and a package for a future one', () => {
    const result = validatePluginPackage({
      ...themes([dark]),
      manifest: { ...themes([dark]).manifest, protocolVersion: 5 },
    });
    expect(result.ok).toBe(false);
  });
});

describe('paired themes (schema 2)', () => {
  const pair = (overrides: Record<string, unknown>[] = [{}, {}]) =>
    themes([
      { ...dark, schemaVersion: 2, variantGroup: 'amber', ...overrides[0] },
      { ...light, schemaVersion: 2, variantGroup: 'amber', ...overrides[1] },
    ]);
  const v3 = (input: ReturnType<typeof themes>) => ({
    ...input,
    manifest: { ...input.manifest, protocolVersion: 3 },
  });

  it('accepts one light and one dark theme sharing a group, under protocol 3', () => {
    const result = validatePluginPackage(v3(pair()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [first, second] = result.value.manifest.contributions as ThemeContribution[];
    expect(first).toMatchObject({ schemaVersion: 2, variantGroup: 'amber', scheme: 'dark' });
    expect(themeVariant([first!, second!], first!, 'light')).toBe(second);
    expect(themeVariant([first!, second!], first!, 'dark')).toBe(first);
  });

  it('needs protocol 3 for schema 2, and refuses a group in schema 1', () => {
    expect(errors(pair())[0]).toMatch(/theme schemaVersion 2 needs protocolVersion 3/);
    expect(errors(v3(themes([{ ...dark, variantGroup: 'amber' }])))[0]).toMatch(
      /variantGroup is not a known field/,
    );
    expect(validatePluginPackage(v3(themes([dark, light]))).ok).toBe(true);
  });

  it('refuses incomplete, doubled or malformed groups', () => {
    expect(errors(v3(themes([{ ...dark, schemaVersion: 2, variantGroup: 'amber' }])))[0]).toMatch(
      /exactly one light and one dark/,
    );
    expect(errors(v3(pair([{}, { scheme: 'dark', editor }])))[0]).toMatch(
      /exactly one light and one dark/,
    );
    const third = { ...light, id: 'amber-paper', schemaVersion: 2, variantGroup: 'amber' };
    expect(
      errors(
        v3(
          themes([
            { ...dark, schemaVersion: 2, variantGroup: 'amber' },
            { ...light, schemaVersion: 2, variantGroup: 'amber' },
            third,
          ]),
        ),
      )[0],
    ).toMatch(/exactly one light and one dark/);
    expect(errors(v3(pair([{ variantGroup: 'Amber' }, {}])))[0]).toMatch(/variantGroup must be/);
    expect(errors(v3(themes([{ ...dark, schemaVersion: 3 }])))[0]).toMatch(/not supported/);
  });

  it('pairs only within a group: an ungrouped theme has no variant', () => {
    const result = validatePluginPackage(v3(themes([dark, light])));
    if (!result.ok) throw new Error(result.errors[0]);
    const all = result.value.manifest.contributions as ThemeContribution[];
    expect(themeVariant(all, all[0]!, 'light')).toBeNull();
  });
});

describe('theme references', () => {
  it('builds and parses plugin:<package>/<contribution>', () => {
    const ref = pluginThemeRef('dev.example.themes', 'amber-dark');
    expect(ref).toBe('plugin:dev.example.themes/amber-dark');
    expect(parsePluginThemeRef(ref)).toEqual({
      packageId: 'dev.example.themes',
      contributionId: 'amber-dark',
    });
    expect(isPluginThemeRef(ref)).toBe(true);
  });

  it('accepts the longest reference the id patterns allow, and nothing longer', () => {
    const longest = `plugin:${'a'.repeat(64)}/${'b'.repeat(48)}`;
    expect(longest).toHaveLength(PLUGIN_THEME_REF_MAX_LENGTH);
    expect(isPluginThemeRef(longest)).toBe(true);
    expect(isPluginThemeRef(`plugin:${'a'.repeat(65)}/b`)).toBe(false);
    expect(isPluginThemeRef(`plugin:a/${'b'.repeat(49)}`)).toBe(false);
    expect(isPluginThemeRef(`${longest}x`)).toBe(false);
  });

  it('refuses anything not exactly one reference', () => {
    for (const value of [
      'plugin:',
      'plugin:/x',
      'plugin:pack/',
      'plugin:pack',
      'plugin:pack/a/b',
      'plugin:Pack/x',
      'plugin:pack/1x',
      'plugin:pack/x_y',
      'Plugin:pack/x',
      ' plugin:pack/x',
      'plugin:pack/x ',
      'plugin:pack/x\n',
      'plugin:../x',
      'studio-dark',
      'builtin',
      null,
      42,
      {},
    ]) {
      expect(isPluginThemeRef(value), String(value)).toBe(false);
    }
    expect(() => pluginThemeRef('Pack', 'x')).toThrow();
  });

  it('sanitizes the app theme: builtin by default, a well-formed reference kept', () => {
    expect(sanitizeAppThemeId(undefined)).toBe('builtin');
    expect(sanitizeAppThemeId('builtin')).toBe('builtin');
    expect(sanitizeAppThemeId('plugin:pack/dark')).toBe('plugin:pack/dark');
    expect(sanitizeAppThemeId('plugin:pack')).toBe('builtin');
    expect(sanitizeAppThemeId('dark')).toBe('builtin');
    expect(sanitizeAppThemeId({ id: 'plugin:pack/dark' })).toBe('builtin');
  });

  it('sanitizes the theme mode: fixed unless it says system', () => {
    expect(sanitizeAppThemeMode('system')).toBe('system');
    expect(sanitizeAppThemeMode('fixed')).toBe('fixed');
    expect(sanitizeAppThemeMode('auto')).toBe('fixed');
    expect(sanitizeAppThemeMode(undefined)).toBe('fixed');
  });
});
