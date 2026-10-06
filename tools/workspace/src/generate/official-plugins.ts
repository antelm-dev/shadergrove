/**
 * Builds the official plugin packages and the release catalogue.
 *
 * Sources live in `plugins/official/<name>/`: a `manifest.json`, a
 * `listing.json` (catalogue-only text such as the description) and, for a
 * package with importers or exporters, `src/index.ts`, the Worker entry. That
 * code is bundled with esbuild into one self-contained script — no imports
 * left, nothing loaded at run time. A package without `src/` is data only
 * (themes, languages) and gets no code. Packages are written beside the
 * catalogue in `apps/studio/src/plugins/`, which the app ships as assets
 * (`plugins/…` under its base URL).
 *
 * The root `i18n/<locale>.json` dictionaries are the one source of the app's
 * text: a language contribution whose source `messages` names one gets that
 * dictionary, and the English one is also written as the app's bundled
 * fallback (`libs/shared/src/i18n/english.generated.ts`). The default themes
 * are likewise the one source of the house palette: their UI colours are also
 * written as the stylesheet's fallback (`apps/studio/src/default-theme.generated.scss`).
 *
 * Every package folder is built; `plugins/official/release.json` lists which
 * of them this release's catalogue offers, in order, so a package can be built
 * and tested before it is listed. The output is deterministic: run with `--check` to fail when the
 * committed files are not what the sources build (`pnpm check:plugins`).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildSync } from 'esbuild';

import {
  CATALOGUE_FORMAT,
  DEFAULT_THEMES_PACKAGE_ID,
  THEME_UI_ROLES,
  isCompleteLanguage,
  isPluginCompatible,
  parsePluginPackage,
  validateCatalogue,
  type CatalogueEntry,
  type PluginCatalogue,
  type PluginPackage,
  type ThemeContribution,
} from '@shadergrove/shared/plugin';
import { APP_VERSION } from '@shadergrove/shared/version';

import { createLogger } from '../lib/logger.js';
import { root } from '../lib/paths.js';

const log = createLogger('official-plugins');
const sourceDir = resolve(root, 'plugins/official');
export const outputDir = resolve(root, 'apps/studio/src/plugins');
/** Generated from the same sources, outside `outputDir`. */
const englishFallbackPath = resolve(root, 'libs/shared/src/i18n/english.generated.ts');
const themeFallbackPath = resolve(root, 'apps/studio/src/default-theme.generated.scss');
const DICTIONARY_PATH = /^i18n\/[a-z]{2,3}(?:-[A-Za-z0-9]+)*\.json$/;

/** What a Worker bundle must never contain: it gets no network, DOM or dynamic code. */
const FORBIDDEN = [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bimportScripts\b/,
  /\bimport\s*\(/,
  /\beval\s*\(/,
  /\bnew\s+Function\b/,
  /\bdocument\./,
];

interface Listing {
  description: string;
}

interface SourceManifest {
  id: string;
  version: string;
  contributions: Record<string, unknown>[];
}

/** Assemble one package's `.sgplugin.json` text: its manifest, and its bundled Worker code if it has any. */
export function buildPackage(name: string): {
  fileName: string;
  text: string;
  listing: Listing;
  plugin: PluginPackage;
} {
  const dir = resolve(sourceDir, name);
  const manifest = JSON.parse(
    readFileSync(resolve(dir, 'manifest.json'), 'utf8'),
  ) as SourceManifest;
  const listing = JSON.parse(readFileSync(resolve(dir, 'listing.json'), 'utf8')) as Listing;
  for (const contribution of manifest.contributions) {
    const messages = contribution['messages'];
    if (contribution['kind'] !== 'language' || typeof messages !== 'string') continue;
    if (!DICTIONARY_PATH.test(messages)) {
      throw new Error(`${name}: a language's messages must name i18n/<locale>.json`);
    }
    contribution['messages'] = JSON.parse(readFileSync(resolve(root, messages), 'utf8'));
  }
  const pkg = existsSync(resolve(dir, 'src/index.ts'))
    ? { manifest, code: bundle(name, dir, manifest) }
    : { manifest };
  const text = `${JSON.stringify(pkg, null, 2)}\n`;
  const parsed = parsePluginPackage(text);
  if (!parsed.ok) throw new Error(`${name}: ${parsed.errors.join('; ')}`);
  for (const contribution of parsed.value.manifest.contributions) {
    if (contribution.kind === 'language' && !isCompleteLanguage(contribution)) {
      throw new Error(`${name}: an official language must translate every key`);
    }
  }
  return {
    fileName: `${manifest.id}-${manifest.version}.sgplugin.json`,
    text,
    listing,
    plugin: parsed.value,
  };
}

/** One package's Worker entry as a single self-contained script. */
function bundle(name: string, dir: string, manifest: SourceManifest): string {
  const result = buildSync({
    absWorkingDir: root,
    entryPoints: [relative(root, resolve(dir, 'src/index.ts'))],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'neutral',
    target: 'es2022',
    charset: 'utf8',
    legalComments: 'none',
    treeShaking: true,
    minifySyntax: true,
    logLevel: 'silent',
  });
  const code = `// ${manifest.id} ${manifest.version} — generated by tools/workspace/src/generate/official-plugins.ts\n${result.outputFiles[0]!.text}`;
  for (const pattern of FORBIDDEN) {
    if (pattern.test(code)) throw new Error(`${name}: the Worker bundle must not use ${pattern}`);
  }
  return code;
}

/** The English the app falls back on, from the dictionary the English pack carries. */
export function buildEnglishFallback(): string {
  const english = JSON.parse(readFileSync(resolve(root, 'i18n/en.json'), 'utf8')) as unknown;
  return [
    '// Generated from i18n/en.json by tools/workspace/src/generate/official-plugins.ts — do not edit.',
    "import type { TranslationKey } from './keys';",
    '',
    '/** The bundled English: what a key reads when no language pack translates it. */',
    `export const ENGLISH_MESSAGES: Readonly<Record<TranslationKey, string>> = ${JSON.stringify(english, null, 2)};`,
    '',
  ].join('\n');
}

/**
 * The stylesheet's fallback palette — painted while no theme is worn — from
 * the default themes' own UI colours, as `light-dark()` pairs.
 */
export function buildThemeFallback(plugin: PluginPackage): string {
  const themes = plugin.manifest.contributions.filter(
    (contribution): contribution is ThemeContribution => contribution.kind === 'theme',
  );
  const light = themes.find((theme) => theme.scheme === 'light');
  const dark = themes.find((theme) => theme.scheme === 'dark');
  if (!light || !dark) throw new Error('default-themes: needs a light and a dark theme');
  const lines: string[] = [];
  for (const role of THEME_UI_ROLES) {
    const [lightValue, darkValue] = [light.ui[role], dark.ui[role]];
    if (lightValue === undefined && darkValue === undefined) continue;
    if (lightValue === undefined || darkValue === undefined) {
      throw new Error(`default-themes: ${role} must be set by both themes or neither`);
    }
    lines.push(`  ${role}: light-dark(${lightValue}, ${darkValue}),`);
  }
  return [
    '// Generated from plugins/official/default-themes by tools/workspace/src/generate/official-plugins.ts — do not edit.',
    '// The house palette of the default themes: what is painted while no theme is worn.',
    '$roles: (',
    ...lines,
    ');',
    '',
  ].join('\n');
}

/** Every generated file, by absolute path. */
export function buildOfficialPlugins(): Map<string, string> {
  const release = JSON.parse(readFileSync(resolve(sourceDir, 'release.json'), 'utf8')) as {
    packages: string[];
  };
  const names = readdirSync(sourceDir, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && existsSync(resolve(sourceDir, entry.name, 'manifest.json')),
    )
    .map((entry) => entry.name)
    .sort();
  for (const name of release.packages) {
    if (!names.includes(name)) throw new Error(`release.json lists unknown package "${name}"`);
  }
  const files = new Map<string, string>();
  const built = new Map(names.map((name) => [name, buildPackage(name)]));
  for (const { fileName, text } of built.values()) files.set(resolve(outputDir, fileName), text);

  const packages: CatalogueEntry[] = [];
  for (const name of release.packages) {
    const { fileName, text, listing, plugin } = built.get(name)!;
    const { manifest } = plugin;
    if (!isPluginCompatible(manifest, APP_VERSION)) {
      throw new Error(
        `${name}: appVersionRange ${manifest.appVersionRange} excludes app ${APP_VERSION}`,
      );
    }
    const bytes = Buffer.from(text, 'utf8');
    packages.push({
      id: manifest.id,
      version: manifest.version,
      name: manifest.name,
      description: listing.description,
      publisher: manifest.publisher,
      license: manifest.license,
      protocolVersion: manifest.protocolVersion,
      appVersionRange: manifest.appVersionRange,
      file: fileName,
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      contributions: manifest.contributions.map(({ kind, id, name: label }) => ({
        kind,
        id,
        name: label,
      })),
    });
  }
  const catalogue: PluginCatalogue = { format: CATALOGUE_FORMAT, packages };
  const valid = validateCatalogue(catalogue);
  if (!valid.ok) throw new Error(`catalogue: ${valid.errors.join('; ')}`);
  files.set(resolve(outputDir, 'catalogue.json'), `${JSON.stringify(catalogue, null, 2)}\n`);

  const themes = [...built.values()].find(
    ({ plugin }) => plugin.manifest.id === DEFAULT_THEMES_PACKAGE_ID,
  );
  if (!themes) throw new Error(`no package is ${DEFAULT_THEMES_PACKAGE_ID}`);
  files.set(themeFallbackPath, buildThemeFallback(themes.plugin));
  files.set(englishFallbackPath, buildEnglishFallback());
  return files;
}

function run(check: boolean): void {
  // Validating a language reads the bundled English this very run may change:
  // write it first, then start over with it loaded.
  const english = buildEnglishFallback();
  if (!check && readFileSync(englishFallbackPath, 'utf8').replace(/\r\n/g, '\n') !== english) {
    writeFileSync(englishFallbackPath, english);
    log.info(`Wrote ${relative(root, englishFallbackPath)}; generating again with it`);
    const again = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
      stdio: 'inherit',
    });
    process.exit(again.status ?? 1);
  }
  const files = buildOfficialPlugins();
  const existing = existsSync(outputDir)
    ? readdirSync(outputDir).map((name) => resolve(outputDir, name))
    : [];
  if (check) {
    const problems: string[] = [];
    for (const [path, text] of files) {
      const name = relative(root, path);
      if (!existsSync(path)) problems.push(`missing ${name}`);
      else if (readFileSync(path, 'utf8').replace(/\r\n/g, '\n') !== text) {
        problems.push(`stale ${name}`);
      }
    }
    for (const path of existing) {
      if (!files.has(path)) problems.push(`unexpected ${relative(root, path)}`);
    }
    if (problems.length > 0) {
      log.error(`Official plugins are out of date (${problems.join(', ')}); run pnpm gen:plugins`);
      process.exit(1);
    }
    log.info(`Official plugins are up to date (${files.size} files)`);
    return;
  }
  mkdirSync(outputDir, { recursive: true });
  for (const path of existing) if (!files.has(path)) rmSync(path);
  for (const [path, text] of files) writeFileSync(path, text);
  log.info(`Wrote ${files.size} files`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  run(process.argv.includes('--check'));
}
