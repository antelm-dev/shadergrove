import { HeroStage } from './hero-stage';
import styles from './hero.module.css';

export function Hero() {
  return (
    <HeroStage
      copy={
        <div className={styles.copy}>
          <p className={`micro ${styles.eyebrow}`}>A workspace for real-time imagination</p>
          <h1 id="heroTitle" className={styles.title}>
            <span className={styles.line}>A little code.</span>{' '}
            <span className={styles.line}>
              A <em>living</em>
            </span>{' '}
            <span className={styles.line}>world.</span>
          </h1>
          <p className={styles.description}>
            A home for your shaders. Write, play and grow your collection in a workspace made for
            real-time creation.
          </p>
          <div className={styles.actions}>
            <a
              className={styles.primaryLink}
              href={
                process.env.NEXT_PUBLIC_STUDIO_URL ||
                'https://github.com/antelm-dev/shadergrove#quick-start'
              }
            >
              Start creating <span aria-hidden="true">↗</span>
            </a>
            <a className="text-link" href="#playground">
              Meet the grove{' '}
              <span className="arrow" aria-hidden="true">
                ↓
              </span>
            </a>
          </div>
          <p className={styles.note}>
            Open source <span aria-hidden="true">/</span> Web &amp; desktop{' '}
            <span aria-hidden="true">/</span> Yours to shape
          </p>
        </div>
      }
    />
  );
}
