import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publicRelease, ReleaseNotFound, ReleasesService } from './releases.service';

const WEB = 'https://github.com/antelm-dev/shadergrove';
const now = Date.parse('2026-10-04T12:00:00Z');

function asset(name: string, version = '1.5.0') {
  return {
    name,
    size: 100,
    state: 'uploaded',
    browser_download_url: `${WEB}/releases/download/v${version}/${name}`,
  };
}

function release(version = '1.5.0', overrides: Record<string, unknown> = {}) {
  return {
    tag_name: `v${version}`,
    name: `Shadergrove ${version}`,
    draft: false,
    prerelease: version.includes('-beta.'),
    published_at: '2026-10-02T19:15:09Z',
    html_url: `${WEB}/releases/tag/v${version}`,
    body: '## New\n\n- A useful feature',
    assets: [asset(`shadergrove-${version}-setup.exe`, version)],
    ...overrides,
  };
}

const upstream = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.stubGlobal('fetch', upstream);
  upstream.mockReset();
  vi.spyOn(Date, 'now').mockReturnValue(now);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('public release contract', () => {
  it('retains downloads for the published Shader Studio releases before the rename', () => {
    const version = '1.3.1';
    const names = [`shader-studio-${version}-setup.exe`, `shader-studio-${version}-portable.exe`];
    const result = publicRelease(
      release(version, { assets: names.map((name) => asset(name, version)) }),
    );
    expect(result?.downloads.map((file) => file.name)).toEqual(names);
    expect(
      result?.downloads.every((file) => file.platform === 'windows' && file.arch === 'x64'),
    ).toBe(true);
  });

  it('admits legacy Windows names and the new Linux and macOS packages', () => {
    const names = [
      'setup.exe',
      'portable.exe',
      'x64.AppImage',
      'x64.deb',
      'x64.dmg',
      'arm64.zip',
      'universal.dmg',
    ].map((suffix) => `shadergrove-1.5.0-${suffix}`);
    const result = publicRelease(release('1.5.0', { assets: names.map((name) => asset(name)) }));
    expect(result?.downloads.map((file) => [file.platform, file.arch, file.kind])).toEqual([
      ['windows', 'x64', 'installer'],
      ['windows', 'x64', 'portable'],
      ['linux', 'x64', 'appimage'],
      ['linux', 'x64', 'deb'],
      ['macos', 'x64', 'dmg'],
      ['macos', 'arm64', 'zip'],
      ['macos', 'universal', 'dmg'],
    ]);
  });

  it('hides drafts, inconsistent channels and unsupported versions', () => {
    expect(publicRelease(release('1.5.0', { draft: true }))).toBeNull();
    expect(publicRelease(release('1.5.0', { prerelease: true }))).toBeNull();
    expect(publicRelease(release('2.0.0-beta.1', { prerelease: false }))).toBeNull();
    expect(publicRelease(release('2.0.0-alpha.1'))).toBeNull();
  });

  it('never exposes updater files, missing files, other versions or external download URLs', () => {
    const valid = asset('shadergrove-1.5.0-setup.exe');
    const result = publicRelease(
      release('1.5.0', {
        assets: [
          valid,
          asset('latest.yml'),
          asset('shadergrove-1.5.0-setup.exe.blockmap'),
          asset('shadergrove-2.0.0-portable.exe'),
          {
            ...asset('shadergrove-1.5.0-portable.exe'),
            browser_download_url: 'https://evil.example/file.exe',
          },
          { ...asset('shadergrove-1.5.0-x64.dmg'), state: 'new' },
        ],
      }),
    );
    expect(result?.downloads).toHaveLength(1);
    expect(result?.downloads[0]?.name).toBe(valid.name);
  });
});

describe('GitHub release catalogue', () => {
  it('uses GitHub latest for stable and shares in-flight requests and the cache', async () => {
    upstream.mockResolvedValue(new Response(JSON.stringify(release())));
    const service = new ReleasesService();
    const results = await Promise.all([service.latest('stable'), service.latest('stable')]);
    expect(results[0]?.version).toBe('1.5.0');
    expect(results[1]).toEqual(results[0]);
    await service.latest('stable');
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(upstream.mock.calls[0]?.[0]).toBe(
      'https://api.github.com/repos/antelm-dev/shadergrove/releases/latest',
    );
    expect(upstream.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('separates stable and beta on the same cached page and filters drafts', async () => {
    upstream.mockResolvedValue(
      new Response(
        JSON.stringify([release(), release('2.0.0-beta.1'), release('2.0.0', { draft: true })]),
      ),
    );
    const service = new ReleasesService();
    expect((await service.list('stable', 1)).releases.map((entry) => entry.version)).toEqual([
      '1.5.0',
    ]);
    expect((await service.latest('beta'))?.version).toBe('2.0.0-beta.1');
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('keeps pagination after a full page even when that channel has no matches', async () => {
    upstream.mockResolvedValue(
      new Response(JSON.stringify(Array.from({ length: 20 }, () => release()))),
    );
    expect(await new ReleasesService().list('beta', 1)).toEqual({ releases: [], nextPage: 2 });
  });

  it('serves known data during rate limiting, backs off, then stops serving over-age data', async () => {
    upstream
      .mockResolvedValueOnce(new Response(JSON.stringify(release())))
      .mockResolvedValue(new Response('', { status: 403 }));
    const service = new ReleasesService();
    await service.latest('stable');
    vi.mocked(Date.now).mockReturnValue(now + 6 * 60_000);
    expect((await service.latest('stable'))?.version).toBe('1.5.0');
    expect((await service.latest('stable'))?.version).toBe('1.5.0');
    expect(upstream).toHaveBeenCalledTimes(2);
    vi.mocked(Date.now).mockReturnValue(now + 25 * 60 * 60_000);
    await expect(service.latest('stable')).rejects.toThrow('403');
  });

  it('backs off when GitHub fails before the first successful request', async () => {
    upstream.mockRejectedValue(new Error('offline'));
    const service = new ReleasesService();
    await expect(service.latest('stable')).rejects.toThrow('offline');
    await expect(service.latest('stable')).rejects.toThrow('offline');
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('does not cache malformed upstream data as a valid release', async () => {
    upstream
      .mockResolvedValueOnce(new Response(JSON.stringify(release())))
      .mockResolvedValue(new Response(JSON.stringify(release('1.5.0', { published_at: null }))));
    const service = new ReleasesService();
    await service.latest('stable');
    vi.mocked(Date.now).mockReturnValue(now + 6 * 60_000);
    expect((await service.latest('stable'))?.version).toBe('1.5.0');
  });

  it('removes a deleted release from the cache and does not expose a private draft', async () => {
    upstream
      .mockResolvedValueOnce(new Response(JSON.stringify(release())))
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(release('2.0.0', { draft: true }))));
    const service = new ReleasesService();
    await service.version('1.5.0');
    vi.mocked(Date.now).mockReturnValue(now + 6 * 60_000);
    await expect(service.version('1.5.0')).rejects.toBeInstanceOf(ReleaseNotFound);
    await expect(service.version('2.0.0')).rejects.toBeInstanceOf(ReleaseNotFound);
  });
});
