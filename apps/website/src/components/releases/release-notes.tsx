import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import styles from './releases.module.css';

/** Raw HTML is disabled. React escapes text and Markdown filters unsafe protocols. */
export function ReleaseNotes({ notes }: { notes: string }) {
  return (
    <div className={styles.notes}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          img: ({ alt }) => <span>{alt}</span>,
          a: ({ href, children }) =>
            href ? (
              <a href={href} rel="noreferrer">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
        }}
      >
        {notes || 'No release notes were provided for this version.'}
      </Markdown>
    </div>
  );
}
