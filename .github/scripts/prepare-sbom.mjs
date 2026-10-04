import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const path = process.argv[2];
const bom = JSON.parse(readFileSync(path, 'utf8'));
assert.equal(bom.bomFormat, 'CycloneDX');
assert.ok(bom.components?.length > 0, 'Workspace SBOM must contain components.');
assert.ok(
  bom.components.some((component) => component.name === 'electron'),
  'Workspace SBOM must include Electron, even though npm classifies it as a devDependency.',
);

const root = new URL('../../', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
bom.metadata ??= {};
bom.metadata.component ??= { type: 'application', name: manifest.name };
bom.metadata.component.version = process.env.SBOM_VERSION?.replace(/^v/, '') || manifest.version;
bom.metadata.properties ??= [];
bom.metadata.properties.push({ name: 'shadergrove:source:commit', value: sha });
writeFileSync(path, `${JSON.stringify(bom, null, 2)}\n`);
console.log(
  `Workspace SBOM: ${bom.components.length} components, including Electron; source ${sha}.`,
);
