import { PaletteCaption } from './palette-caption';
import styles from './site-footer.module.css';

export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <span>Shadergrove — built from light, yours to shape.</span>
      <nav className={styles.links} aria-label="Footer navigation">
        <a href="/download">Download</a>
        <a href="/changelog">Changelog</a>
        <a href="https://github.com/antelm-dev/shadergrove">GitHub ↗</a>
      </nav>
      <PaletteCaption />
    </footer>
  );
}
