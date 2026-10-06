import type { ReleaseChannel } from './catalogue';
import styles from './releases.module.css';

export function ChannelTabs({
  channel,
  page,
}: {
  channel: ReleaseChannel;
  page: 'download' | 'changelog';
}) {
  return (
    <nav className={styles.channels} aria-label="Release channel">
      <a href={`/${page}`} aria-current={channel === 'stable' ? 'page' : undefined}>
        Stable
      </a>
      <a href={`/${page}?channel=beta`} aria-current={channel === 'beta' ? 'page' : undefined}>
        Beta
      </a>
    </nav>
  );
}

export function CatalogueStatus({
  loading,
  error,
  retry,
}: {
  loading: boolean;
  error: string | null;
  retry: () => void;
}) {
  if (loading)
    return (
      <p className={styles.status} role="status">
        Loading releases…
      </p>
    );
  if (error)
    return (
      <div className={styles.status} role="alert">
        <p>{error}</p>
        <button className={styles.secondary} onClick={retry}>
          Try again
        </button>
      </div>
    );
  return null;
}
