import { isPlatformServer } from '@angular/common';
import { PLATFORM_ID, TransferState, inject, makeStateKey } from '@angular/core';

/**
 * What the Explore pages share.
 *
 * A page here is a routed component laid over the editor, below the title bar
 * and toolbar (`--app-page-top`, measured by `App`), which keep the Editor /
 * Explore / Plugins links in reach. The editor is not replaced: it stays mounted
 * underneath with its open shader and any unsaved draft, which is why visiting
 * Explore never asks to save first. The page itself is what scrolls.
 */
export const PAGE_STYLES = `
  :host {
    position: fixed;
    inset: var(--app-page-top, 0px) 0 0;
    z-index: 20;
    display: flex;
    flex-direction: column;
    overflow: auto;
    background: var(--mat-sys-surface);
    color: var(--mat-sys-on-surface);
  }

  .page-bar {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    flex: 0 0 auto;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 16px;
    padding: 8px 16px;
    border-bottom: 1px solid var(--mat-sys-outline-variant);
    background: var(--mat-sys-surface-container-low);
  }

  .page-bar h1 {
    margin: 0;
    font: var(--mat-sys-title-medium);
  }

  main {
    box-sizing: border-box;
    width: min(1120px, 100%);
    margin: 0 auto;
    padding: 20px 16px 40px;
  }

  .status {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    margin: 24px 0;
    color: var(--mat-sys-on-surface-variant);
    font: var(--mat-sys-body-large);
  }
`;

/**
 * Carries what the server rendered with into the browser's first render, so
 * hydration starts from the same list instead of an empty one that fills in a
 * moment later. Only ever public data: it ends up in the page's HTML.
 */
export function serverState<T>(name: string): { take(): T | null; put(value: T): void } {
  const transfer = inject(TransferState);
  const onServer = isPlatformServer(inject(PLATFORM_ID));
  const key = makeStateKey<T>(name);
  return {
    take: () => {
      const value = transfer.get<T | null>(key, null);
      transfer.remove(key);
      return value;
    },
    put: (value) => {
      if (onServer) transfer.set(key, value);
    },
  };
}
