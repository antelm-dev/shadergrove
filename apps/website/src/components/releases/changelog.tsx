'use client';

import { useEffect, useState } from 'react';
import { ChannelTabs, CatalogueStatus } from './channel-tabs';
import {
  downloadsHref,
  formatDate,
  notesHref,
  useReleaseQuery,
  useReleaseRequest,
  type PublicRelease,
  type ReleasePage,
} from './catalogue';
import { ReleaseNotes } from './release-notes';
import styles from './releases.module.css';

export function Changelog() {
  const query = useReleaseQuery();
  const [page, setPage] = useState(1);
  const [history, setHistory] = useState<PublicRelease[]>([]);
  const path = !query.ready
    ? null
    : query.version
      ? `/${encodeURIComponent(query.version)}`
      : `?channel=${query.channel}&page=${page}`;
  const { data, loading, error, retry } = useReleaseRequest<PublicRelease | ReleasePage>(path);
  const listing = data && 'releases' in data ? data : null;
  const selected = data && 'version' in data ? data : null;
  useEffect(() => {
    setPage(1);
    setHistory([]);
  }, [query.channel, query.version]);
  const releases = selected
    ? [selected]
    : [
        ...new Map(
          [...history, ...(listing?.releases ?? [])].map((release) => [release.version, release]),
        ).values(),
      ];
  return (
    <section className={styles.page} aria-labelledby="changelog-title">
      <div className={styles.intro}>
        <p className="micro">Growing, one release at a time</p>
        <h1 id="changelog-title">
          What’s <em>new.</em>
        </h1>
        <p className={styles.lead}>
          New possibilities, thoughtful improvements and the fixes that keep you creating.
        </p>
      </div>
      <ChannelTabs channel={selected?.channel ?? query.channel} page="changelog" />
      {query.version && (
        <a
          className="text-link"
          href={selected?.channel === 'beta' ? '/changelog?channel=beta' : '/changelog'}
        >
          ← All releases
        </a>
      )}
      {query.channel === 'beta' && !query.version && (
        <p className={styles.betaNotice}>
          Preview releases are listed here separately from stable versions.
        </p>
      )}
      {releases.map((release) => (
        <article className={styles.release} key={release.version}>
          <header className={styles.releaseHeader}>
            <div>
              <span className={styles.badge}>{release.channel === 'beta' ? 'Beta' : 'Stable'}</span>
              <h2>
                <a href={notesHref(release)}>{release.title}</a>
              </h2>
              <time dateTime={release.publishedAt}>{formatDate(release.publishedAt)}</time>
            </div>
            <a className={styles.secondary} href={downloadsHref(release)}>
              Download {release.version} ↓
            </a>
          </header>
          <ReleaseNotes notes={release.notes} />
        </article>
      ))}
      <CatalogueStatus loading={loading} error={error} retry={retry} />
      {!loading && !error && releases.length === 0 && (
        <p className={styles.status}>No {query.channel} releases on this page yet.</p>
      )}
      {listing?.nextPage && !loading && (
        <button
          className={styles.secondary}
          onClick={() => {
            setHistory(releases);
            setPage(listing.nextPage!);
          }}
        >
          Load older releases ↓
        </button>
      )}
      <noscript>
        <p>
          Enable JavaScript to read the release history.{' '}
          <a href="https://github.com/antelm-dev/shadergrove/releases">Browse published releases</a>
          .
        </p>
      </noscript>
    </section>
  );
}
