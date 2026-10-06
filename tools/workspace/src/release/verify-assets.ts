import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

type Platform = 'windows' | 'linux' | 'macos';
interface Asset {
  name: string;
  size: number;
}

export function expectedAssets(
  version: string,
  channel: 'latest' | 'beta',
  platforms: Platform[],
): string[] {
  return platforms.flatMap((platform) => {
    switch (platform) {
      case 'windows':
        return [
          `shadergrove-${version}-setup.exe`,
          `shadergrove-${version}-setup.exe.blockmap`,
          `shadergrove-${version}-portable.exe`,
          `${channel}.yml`,
        ];
      case 'linux':
        return [
          `shadergrove-${version}-x64.AppImage`,
          `shadergrove-${version}-x64.deb`,
          `${channel}-linux.yml`,
        ];
      case 'macos':
        return ['x64', 'arm64']
          .flatMap((arch) => [
            `shadergrove-${version}-${arch}.dmg`,
            `shadergrove-${version}-${arch}.zip`,
          ])
          .concat(`${channel}-mac.yml`);
    }
  });
}

export const sbomAssets = ['workspace.cdx.json', 'studio-image.cdx.json', 'website-image.cdx.json'];

export function verifyAssets(
  version: string,
  channel: 'latest' | 'beta',
  platforms: Platform[],
  assets: Asset[],
  manifests: Record<string, string>,
): void {
  const byName = new Map(assets.map((asset) => [asset.name, asset.size]));
  const required = [...expectedAssets(version, channel, platforms), ...sbomAssets];
  for (const name of required) {
    const size = byName.get(name);
    if (size === undefined || !Number.isSafeInteger(size) || size <= 0)
      throw new Error(`Missing or empty release asset: ${name}`);
  }
  for (const platform of platforms) {
    const platformAssets = expectedAssets(version, channel, [platform]);
    const updaterFiles =
      platform === 'windows'
        ? [`shadergrove-${version}-setup.exe`]
        : platform === 'linux'
          ? [`shadergrove-${version}-x64.AppImage`]
          : ['x64', 'arm64'].map((arch) => `shadergrove-${version}-${arch}.zip`);
    const suffix = platform === 'windows' ? '' : platform === 'linux' ? '-linux' : '-mac';
    const name = `${channel}${suffix}.yml`;
    const info = parse(manifests[name] ?? '') as {
      version?: unknown;
      path?: unknown;
      files?: { url?: unknown; size?: unknown; sha512?: unknown }[];
    } | null;
    if (
      !info ||
      info.version !== version ||
      typeof info.path !== 'string' ||
      !updaterFiles.includes(info.path) ||
      !Array.isArray(info.files) ||
      !info.files.length
    ) {
      throw new Error(`Invalid update manifest: ${name}`);
    }
    const files = info.files;
    for (const file of files) {
      if (
        typeof file.url !== 'string' ||
        !platformAssets.includes(file.url) ||
        file.size !== byName.get(file.url) ||
        typeof file.sha512 !== 'string' ||
        !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512)
      ) {
        throw new Error(`Manifest ${name} references an invalid or mismatched release asset`);
      }
    }
    if (
      !files.some((file) => file.url === info.path) ||
      updaterFiles.some((file) => !files.some((entry) => entry.url === file))
    ) {
      throw new Error(`Manifest ${name} does not cover the expected updater packages`);
    }
  }
}

function main(): void {
  const [tag, channel, list] = process.argv.slice(2);
  if (
    !tag ||
    !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/.test(tag) ||
    (channel !== 'latest' && channel !== 'beta')
  )
    throw new Error('Usage: verify:release <tag> <latest|beta> <windows,linux,macos>');
  if (tag.includes('-beta.') !== (channel === 'beta'))
    throw new Error('Release tag and channel disagree');
  const platforms = (list ?? 'windows').split(',');
  if (platforms.some((platform) => !['windows', 'linux', 'macos'].includes(platform)))
    throw new Error('Unknown release platform');
  const gh = (args: string[]) =>
    execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  const assets = JSON.parse(
    gh(['release', 'view', tag, '--json', 'assets', '--jq', '.assets']),
  ) as Asset[];
  const manifests = Object.fromEntries(
    expectedAssets(tag.slice(1), channel, platforms as Platform[])
      .filter((name) => name.endsWith('.yml'))
      .map((name) => [name, gh(['release', 'download', tag, '--pattern', name, '--output', '-'])]),
  );
  verifyAssets(tag.slice(1), channel, platforms as Platform[], assets, manifests);
  console.log(`Verified ${tag} assets for ${platforms.join(', ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
