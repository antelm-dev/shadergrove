'use client';

import { useEffect, useState } from 'react';
import type { DesktopPlatform } from '@shadergrove/shared/model';
import { ChannelTabs, CatalogueStatus } from './channel-tabs';
import {
  formatDate,
  formatSize,
  notesHref,
  packageLabel,
  useReleaseQuery,
  useReleaseRequest,
  type PublicRelease,
  type LatestRelease,
} from './catalogue';
import styles from './releases.module.css';

const platforms: { key: DesktopPlatform; name: string; symbol: string }[] = [
  { key: 'windows', name: 'Windows', symbol: '⊞' },
  { key: 'linux', name: 'Linux', symbol: '◈' },
  { key: 'macos', name: 'macOS', symbol: '⌘' },
];

export function Downloads() {
  const query = useReleaseQuery();
  const path = !query.ready
    ? null
    : query.version
      ? `/${encodeURIComponent(query.version)}`
      : `/latest?channel=${query.channel}`;
  const { data, loading, error, retry } = useReleaseRequest<PublicRelease | LatestRelease>(path);
  const release = data && 'release' in data ? data.release : data;
  const [platform, setPlatform] = useState<DesktopPlatform | null>(null);
  useEffect(() => {
    const agent = navigator.userAgent;
    setPlatform(
      /Windows/i.test(agent)
        ? 'windows'
        : /Macintosh|Mac OS X/i.test(agent) &&
            !/iPad|iPhone/i.test(agent) &&
            navigator.maxTouchPoints < 2
          ? 'macos'
          : /Linux/i.test(agent) && !/Android/i.test(agent)
            ? 'linux'
            : null,
    );
  }, []);
  return (
    <section className={styles.page} aria-labelledby="download-title">
      <div className={styles.intro}>
        <p className="micro">Your workspace, on your machine</p>
        <h1 id="download-title">
          A home for your shaders.
          <br />
          <em>Anywhere you create.</em>
        </h1>
        <p className={styles.lead}>
          Download Shadergrove for your desktop. Write, experiment and keep your collection close.
        </p>
      </div>
      <ChannelTabs channel={release?.channel ?? query.channel} page="download" />
      <CatalogueStatus loading={loading} error={error} retry={retry} />
      {!loading && !error && !release && (
        <p className={styles.status}>
          No {query.channel} release is available yet.{' '}
          <a className="text-link" href="/download">
            Browse stable releases →
          </a>
        </p>
      )}
      {release && (
        <>
          <div className={styles.releaseMeta}>
            <div>
              <span className={styles.badge}>{release.channel === 'beta' ? 'Beta' : 'Stable'}</span>
              <strong>Version {release.version}</strong>
              <time dateTime={release.publishedAt}>{formatDate(release.publishedAt)}</time>
            </div>
            <a className="text-link" href={notesHref(release)}>
              See what’s new ↗
            </a>
          </div>
          {release.channel === 'beta' && (
            <p className={styles.betaNotice}>
              This is a preview release. Features may change and you may encounter issues.
            </p>
          )}
          <div className={styles.grid}>
            {platforms.map(({ key, name, symbol }) => {
              const downloads = release.downloads.filter((download) => download.platform === key);
              return (
                <article
                  key={key}
                  className={`${styles.platform} ${platform === key && downloads.length ? styles.recommended : ''}`}
                >
                  <div className={styles.platformHeading}>
                    <span aria-hidden="true" className={styles.platformIcon}>
                      {symbol}
                    </span>
                    {platform === key && downloads.length > 0 && (
                      <span className="micro">For your system</span>
                    )}
                  </div>
                  <h2>{name}</h2>
                  {downloads.length > 0 ? (
                    <div className={styles.packageList}>
                      {downloads.map((download) => (
                        <a key={download.name} className={styles.package} href={download.url}>
                          <span>
                            {packageLabel(download)}
                            <small>{formatSize(download.size)}</small>
                          </span>
                          <span aria-hidden="true">↓</span>
                        </a>
                      ))}
                    </div>
                  ) : (
                    <p className={styles.unavailable}>
                      A {name} build is not available for this version yet.
                    </p>
                  )}
                  {key === 'linux' &&
                    downloads.some((download) => download.kind === 'appimage') && (
                      <p className={styles.hint}>
                        For AppImage, allow the file to run as a program before opening it.
                      </p>
                    )}
                  {key === 'windows' &&
                    downloads.some((download) => download.kind === 'portable') && (
                      <p className={styles.hint}>
                        Choose the installer for automatic updates, or portable to run without
                        installing.
                      </p>
                    )}
                </article>
              );
            })}
          </div>
        </>
      )}
      {process.env.NEXT_PUBLIC_STUDIO_URL && (
        <div className={styles.webAlternative}>
          <div>
            <h2>Keep creating in your browser.</h2>
            <p>The web studio is always a click away.</p>
          </div>
          <a className={styles.secondary} href={process.env.NEXT_PUBLIC_STUDIO_URL}>
            Open web studio ↗
          </a>
        </div>
      )}
      <noscript>
        <p>
          Enable JavaScript to see the current release and its downloads.{' '}
          <a href="https://github.com/antelm-dev/shadergrove/releases">Browse published releases</a>
          .
        </p>
      </noscript>
    </section>
  );
}
