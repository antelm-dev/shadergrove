import { Injectable, Logger } from '@nestjs/common';
import type {
  DesktopDownload,
  DesktopPackage,
  DesktopPlatform,
  PublicRelease,
  ReleaseChannel,
  ReleasePage,
} from '@shadergrove/shared/model';

const REPOSITORY = 'antelm-dev/shadergrove';
const API = `https://api.github.com/repos/${REPOSITORY}`;
const WEB = `https://github.com/${REPOSITORY}`;
const PAGE_SIZE = 20;
const TTL = 5 * 60_000;
const STALE_TTL = 24 * 60 * 60_000;
const RETRY_TTL = 60_000;
const CACHE_LIMIT = 128;

// Match only the channels this product publishes, including older stable releases.
export const RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.(0|[1-9]\d*))?$/;

export class ReleaseNotFound extends Error {}

interface CachedRelease {
  value?: unknown;
  fetchedAt: number;
  expiresAt: number;
  pending?: Promise<unknown>;
  error?: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Admit only actual installers for this release, never source archives or updater files. */
function download(value: unknown, version: string, tag: string): DesktopDownload | null {
  const asset = record(value);
  if (!asset || asset['state'] !== 'uploaded') return null;
  const name = asset['name'];
  const size = asset['size'];
  if (typeof name !== 'string' || !Number.isSafeInteger(size) || (size as number) <= 0) return null;
  const prefix = [`shadergrove-${version}-`, `shader-studio-${version}-`].find((value) =>
    name.startsWith(value),
  );
  if (!prefix) return null;
  const suffix = name.slice(prefix.length);
  let platform: DesktopPlatform;
  let kind: DesktopPackage;
  let arch: DesktopDownload['arch'] = 'x64';
  const windows = /^(?:(x64|arm64)-)?(setup|portable)\.exe$/.exec(suffix);
  const unix = /^(x64|arm64|universal)\.(AppImage|deb|dmg|zip)$/.exec(suffix);
  if (windows) {
    platform = 'windows';
    arch = windows[1] === 'arm64' ? 'arm64' : 'x64';
    kind = windows[2] === 'setup' ? 'installer' : 'portable';
  } else if (unix) {
    arch = unix[1] as DesktopDownload['arch'];
    const extension = unix[2];
    platform = extension === 'AppImage' || extension === 'deb' ? 'linux' : 'macos';
    if (arch === 'universal' && platform === 'linux') return null;
    kind = extension === 'AppImage' ? 'appimage' : (extension as DesktopPackage);
  } else return null;

  const url = `${WEB}/releases/download/${tag}/${name}`;
  if (asset['browser_download_url'] !== url) return null;
  return { name, url, size: size as number, platform, arch, kind };
}

export function publicRelease(value: unknown): PublicRelease | null {
  const release = record(value);
  if (!release || release['draft'] !== false || typeof release['prerelease'] !== 'boolean')
    return null;
  const tag = release['tag_name'];
  if (typeof tag !== 'string' || !tag.startsWith('v')) return null;
  const version = tag.slice(1);
  if (!RELEASE_VERSION.test(version)) return null;
  const channel: ReleaseChannel = version.includes('-beta.') ? 'beta' : 'stable';
  if (release['prerelease'] !== (channel === 'beta')) return null;
  const publishedAt = release['published_at'];
  if (typeof publishedAt !== 'string' || !Number.isFinite(Date.parse(publishedAt))) return null;
  if (release['html_url'] !== `${WEB}/releases/tag/${tag}` || !Array.isArray(release['assets']))
    return null;
  return {
    version,
    channel,
    title:
      typeof release['name'] === 'string' && release['name']
        ? release['name']
        : `Shadergrove ${version}`,
    publishedAt,
    notes: typeof release['body'] === 'string' ? release['body'] : '',
    url: `${WEB}/releases/tag/${tag}`,
    downloads: release['assets']
      .map((asset: unknown) => download(asset, version, tag))
      .filter((asset): asset is DesktopDownload => asset !== null),
  };
}

@Injectable()
export class ReleasesService {
  private readonly logger = new Logger('releases');
  private readonly cache = new Map<string, CachedRelease>();

  async list(channel: ReleaseChannel, page: number): Promise<ReleasePage> {
    const raw = await this.read(`/releases?per_page=${PAGE_SIZE}&page=${page}`);
    if (!Array.isArray(raw)) throw new Error('Invalid release catalogue');
    const releases = raw
      .map(publicRelease)
      .filter((release): release is PublicRelease => release !== null);
    return {
      releases: releases
        .filter((release) => release.channel === channel)
        .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)),
      nextPage: raw.length === PAGE_SIZE && page < 100 ? page + 1 : null,
    };
  }

  async latest(channel: ReleaseChannel): Promise<PublicRelease | null> {
    if (channel === 'stable') {
      try {
        const release = publicRelease(await this.read('/releases/latest'));
        if (!release || release.channel !== 'stable') throw new Error('Invalid latest release');
        return release;
      } catch (error) {
        if (error instanceof ReleaseNotFound) return null;
        throw error;
      }
    }
    // GitHub's /latest explicitly excludes prereleases. Look through the same cached
    // catalogue the changelog uses; a stable release must never be presented as beta.
    for (let page = 1; page <= 5; page++) {
      const result = await this.list('beta', page);
      if (result.releases[0]) return result.releases[0];
      if (!result.nextPage) break;
    }
    return null;
  }

  async version(version: string): Promise<PublicRelease> {
    const release = publicRelease(await this.read(`/releases/tags/v${version}`));
    if (!release || release.version !== version) throw new ReleaseNotFound();
    return release;
  }

  private async read(path: string): Promise<unknown> {
    const now = Date.now();
    let cached = this.cache.get(path);
    if (cached && cached.expiresAt > now) {
      if (cached.error) throw cached.error;
      return cached.value;
    }
    if (cached?.pending) return cached.pending;
    cached ??= { fetchedAt: 0, expiresAt: 0 };
    this.cache.delete(path);
    this.cache.set(path, cached);
    if (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value!);
    const entry = cached;
    entry.pending = this.fetch(path)
      .then((value) => {
        entry.value = value;
        entry.error = undefined;
        entry.fetchedAt = Date.now();
        entry.expiresAt = entry.fetchedAt + TTL;
        return value;
      })
      .catch((error: unknown) => {
        entry.expiresAt = Date.now() + RETRY_TTL;
        // Retain known public data through transient network/rate-limit failures.
        // A definitive deletion (404) must immediately stop serving that release.
        if (
          !(error instanceof ReleaseNotFound) &&
          entry.value !== undefined &&
          Date.now() - entry.fetchedAt < STALE_TTL
        ) {
          this.logger.warn('GitHub unavailable; serving cached release information');
          return entry.value;
        }
        entry.value = undefined;
        entry.error = error;
        throw error;
      })
      .finally(() => {
        entry.pending = undefined;
      });
    return entry.pending;
  }

  private async fetch(path: string): Promise<unknown> {
    const token = process.env['GITHUB_RELEASES_TOKEN'];
    const response = await fetch(`${API}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Shadergrove-release-catalogue',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(8_000),
      redirect: 'error',
    });
    if (response.status === 404) throw new ReleaseNotFound();
    if (!response.ok) throw new Error(`GitHub releases returned ${response.status}`);
    const value: unknown = await response.json();
    const isRelease = (item: unknown) => {
      const release = record(item);
      if (
        !release ||
        typeof release['tag_name'] !== 'string' ||
        typeof release['draft'] !== 'boolean' ||
        typeof release['prerelease'] !== 'boolean' ||
        !Array.isArray(release['assets'])
      )
        return false;
      return (
        release['draft'] ||
        !RELEASE_VERSION.test(release['tag_name'].replace(/^v/, '')) ||
        publicRelease(release) !== null
      );
    };
    if (Array.isArray(value) ? !value.every(isRelease) : !isRelease(value)) {
      throw new Error('Invalid release response');
    }
    if (!Array.isArray(value) && record(value)?.['draft'] === true) throw new ReleaseNotFound();
    if (path === '/releases/latest' && publicRelease(value)?.channel !== 'stable') {
      throw new Error('Invalid latest stable release');
    }
    return value;
  }
}
