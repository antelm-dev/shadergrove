'use client';

import { useEffect, useState } from 'react';
import type { DesktopDownload, PublicRelease, ReleaseChannel } from '@shadergrove/shared/model';

export type {
  DesktopDownload,
  PublicRelease,
  ReleaseChannel,
  ReleasePage,
  LatestRelease,
} from '@shadergrove/shared/model';

const studioUrl = process.env.NEXT_PUBLIC_STUDIO_URL;
const releasesApi =
  process.env.NEXT_PUBLIC_RELEASES_API_URL ||
  (studioUrl ? new URL('/api/releases', studioUrl).href : '/api/releases');

export function notesHref(release: PublicRelease): string {
  return `/changelog?version=${encodeURIComponent(release.version)}`;
}

export function downloadsHref(release: PublicRelease): string {
  return `/download?version=${encodeURIComponent(release.version)}`;
}

export function formatDate(value: string): string {
  return new Intl.DateTimeFormat('en', { dateStyle: 'long', timeZone: 'UTC' }).format(
    new Date(value),
  );
}

export function formatSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function packageLabel(download: DesktopDownload): string {
  const labels = {
    installer: 'Installer',
    portable: 'Portable',
    appimage: 'AppImage',
    deb: 'Debian / Ubuntu',
    dmg: 'Disk image',
    zip: 'ZIP archive',
  };
  const arch =
    download.platform === 'macos'
      ? { x64: 'Intel', arm64: 'Apple Silicon', universal: 'Universal' }[download.arch]
      : download.arch === 'arm64'
        ? 'ARM64'
        : '64-bit';
  return `${labels[download.kind]} · ${arch}`;
}

export function useReleaseQuery() {
  const [query, setQuery] = useState<{
    ready: boolean;
    channel: ReleaseChannel;
    version: string | null;
  }>({ ready: false, channel: 'stable', version: null });
  useEffect(() => {
    const update = () => {
      const params = new URLSearchParams(window.location.search);
      setQuery({
        ready: true,
        channel: params.get('channel') === 'beta' ? 'beta' : 'stable',
        version: params.get('version'),
      });
    };
    update();
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  return query;
}

export function useReleaseRequest<T>(path: string | null) {
  const [state, setState] = useState<{
    path: string | null;
    data: T | null;
    error: string | null;
    loading: boolean;
  }>({ path: null, data: null, error: null, loading: true });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    setState({ path, data: null, error: null, loading: true });
    void fetch(`${releasesApi.replace(/\/$/, '')}${path}`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
      credentials: 'omit',
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            response.status === 404
              ? 'This release could not be found.'
              : response.status === 400
                ? 'This release link is invalid.'
                : 'Release information is temporarily unavailable. Please try again.',
          );
        return (await response.json()) as T;
      })
      .then((data) => {
        if (!controller.signal.aborted) setState({ path, data, error: null, loading: false });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            path,
            data: null,
            error:
              error instanceof Error && error.name !== 'TimeoutError'
                ? error.message
                : 'Release information is temporarily unavailable. Please try again.',
            loading: false,
          });
      });
    return () => controller.abort();
  }, [path, attempt]);
  return {
    ...(state.path === path ? state : { data: null, error: null, loading: true }),
    retry: () => setAttempt((value) => value + 1),
  };
}
