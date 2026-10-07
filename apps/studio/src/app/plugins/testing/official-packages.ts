import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Bundled with the spec that imports it, `import.meta.dirname` is that spec's folder:
// found by walking up rather than by a fixed number of `..`.
const generated = (() => {
  for (let dir = import.meta.dirname; dir !== dirname(dir); dir = dirname(dir)) {
    const candidate = resolve(dir, 'src/plugins');
    if (existsSync(resolve(candidate, 'catalogue.json'))) return candidate;
  }
  throw new Error('No generated plugins found above ' + import.meta.dirname);
})();

/** The text of a package this release ships, by id, exactly as its catalogue lists it. */
export function officialPackageText(id: string): string {
  const catalogue = JSON.parse(readFileSync(resolve(generated, 'catalogue.json'), 'utf8')) as {
    packages: { id: string; file: string }[];
  };
  const entry = catalogue.packages.find((item) => item.id === id);
  if (!entry) throw new Error(`The catalogue lists no package ${id}`);
  return readFileSync(resolve(generated, entry.file), 'utf8');
}

/** A theme package as protocol 1 had it, from before pairs: every theme fixed to its scheme. */
export function withUnpairedThemes(text: string): string {
  const json = JSON.parse(text) as {
    manifest: { protocolVersion: number; contributions: Record<string, unknown>[] };
  };
  json.manifest.protocolVersion = 1;
  for (const theme of json.manifest.contributions) {
    theme['schemaVersion'] = 1;
    delete theme['variantGroup'];
  }
  return JSON.stringify(json);
}
