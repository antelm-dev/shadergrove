import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { expectedAssets, verifyAssets } from './verify-assets';

const platforms = ['windows', 'linux', 'macos'] as const;
const checksum = Buffer.alloc(64).toString('base64');

function fixture(channel: 'latest' | 'beta' = 'latest', version = '2.0.0') {
  const assets = expectedAssets(version, channel, [...platforms]).map((name) => ({
    name,
    size: 100,
  }));
  const manifests = Object.fromEntries(
    [
      ['', [`shadergrove-${version}-setup.exe`]],
      ['-linux', [`shadergrove-${version}-x64.AppImage`]],
      ['-mac', [`shadergrove-${version}-x64.zip`, `shadergrove-${version}-arm64.zip`]],
    ].map(([suffix, names]) => {
      const files = names as string[];
      return [
        `${channel}${suffix as string}.yml`,
        stringify({
          version,
          path: files[0],
          files: files.map((url) => ({ url, size: 100, sha512: checksum })),
        }),
      ];
    }),
  );
  return { assets, manifests };
}

describe('complete release verification', () => {
  it('accepts stable and beta packages for all enabled platforms', () => {
    const stable = fixture();
    verifyAssets('2.0.0', 'latest', [...platforms], stable.assets, stable.manifests);
    const beta = fixture('beta', '2.1.0-beta.1');
    verifyAssets('2.1.0-beta.1', 'beta', [...platforms], beta.assets, beta.manifests);
  });

  it('requires only Windows while Linux and macOS are disabled', () => {
    const { assets, manifests } = fixture();
    verifyAssets(
      '2.0.0',
      'latest',
      ['windows'],
      assets.filter(
        (asset) =>
          asset.name.endsWith('.exe') ||
          asset.name.endsWith('.blockmap') ||
          asset.name === 'latest.yml',
      ),
      manifests,
    );
  });

  it('refuses to publish when an enabled platform or update manifest is missing', () => {
    const { assets, manifests } = fixture();
    for (const missing of [
      'shadergrove-2.0.0-x64.AppImage',
      'shadergrove-2.0.0-arm64.dmg',
      'shadergrove-2.0.0-setup.exe.blockmap',
      'latest-mac.yml',
    ]) {
      expect(() =>
        verifyAssets(
          '2.0.0',
          'latest',
          [...platforms],
          assets.filter((asset) => asset.name !== missing),
          manifests,
        ),
      ).toThrow('Missing or empty');
    }
  });

  it('rejects another version, mismatched sizes, bad checksums and external updater URLs', () => {
    for (const changes of [
      { version: '1.0.0' },
      { size: 101 },
      { sha512: 'bad' },
      { url: 'https://evil.example/app.exe' },
    ]) {
      const { assets, manifests } = fixture();
      manifests['latest.yml'] = stringify({
        version: '2.0.0',
        path: 'shadergrove-2.0.0-setup.exe',
        ...('version' in changes ? changes : {}),
        files: [{ url: 'shadergrove-2.0.0-setup.exe', size: 100, sha512: checksum, ...changes }],
      });
      expect(() => verifyAssets('2.0.0', 'latest', [...platforms], assets, manifests)).toThrow();
    }
  });

  it('requires both Mac architectures in the combined updater manifest', () => {
    const { assets, manifests } = fixture();
    manifests['latest-mac.yml'] = stringify({
      version: '2.0.0',
      path: 'shadergrove-2.0.0-x64.zip',
      files: [{ url: 'shadergrove-2.0.0-x64.zip', size: 100, sha512: checksum }],
    });
    expect(() => verifyAssets('2.0.0', 'latest', [...platforms], assets, manifests)).toThrow(
      'expected updater packages',
    );
  });

  it('rejects a manifest pointing at a package from a different platform', () => {
    const { assets, manifests } = fixture();
    manifests['latest.yml'] = stringify({
      version: '2.0.0',
      path: 'shadergrove-2.0.0-x64.AppImage',
      files: [
        { url: 'shadergrove-2.0.0-setup.exe', size: 100, sha512: checksum },
        { url: 'shadergrove-2.0.0-x64.AppImage', size: 100, sha512: checksum },
      ],
    });
    expect(() => verifyAssets('2.0.0', 'latest', [...platforms], assets, manifests)).toThrow();
  });
});
