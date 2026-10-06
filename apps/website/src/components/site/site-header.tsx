import { GROVE_PALETTES } from '@shadergrove/brand';
import Link from 'next/link';

import { StaticGrove } from '@/components/grove/static-grove';

import styles from './site-header.module.css';

export function SiteHeader() {
  return (
    <header className={styles.masthead}>
      <Link className={styles.wordmark} href="/" aria-label="Shadergrove home">
        <StaticGrove
          className={styles.brandMark}
          palette={GROVE_PALETTES.grove}
          samples={3}
          size={36}
          aria-hidden="true"
        />
        Shadergrove
      </Link>
      <nav className={styles.navigation} aria-label="Main navigation">
        <Link className={styles.desktopLink} href="/#workflow">
          The workspace
        </Link>
        <Link className={styles.desktopLink} href="/#playground">
          The grove
        </Link>
        <Link className={styles.desktopLink} href="/changelog">
          Changelog
        </Link>
        <Link className={styles.navCta} href="/download">
          Download{' '}
          <span className="arrow" aria-hidden="true">
            ↗
          </span>
        </Link>
      </nav>
    </header>
  );
}
