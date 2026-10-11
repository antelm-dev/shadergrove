/**
 * The tab strip, header buttons and tab panels the docked bottom panel and its
 * native window share, so the two look the same.
 */
export const PANEL_CHROME_STYLES = `
    .header {
      display: flex;
      align-items: center;
      flex: 0 0 auto;
      gap: 4px;
      min-height: 34px;
      padding: 3px 5px 3px 7px;
      border-bottom: 1px solid var(--mat-sys-outline-variant);
      background: var(--mat-sys-surface-container-low);
    }

    .tablist {
      display: flex;
      align-items: center;
      gap: 2px;
      min-width: 0;
    }

    .tab {
      display: flex;
      align-items: center;
      gap: 6px;
      height: 28px;
      padding-inline: 10px;
      border: 0;
      border-radius: var(--mat-sys-corner-small, 6px);
      background: transparent;
      color: var(--mat-sys-on-surface-variant);
      font: var(--mat-sys-label-medium);
      white-space: nowrap;
      cursor: pointer;

      mat-icon {
        width: 16px;
        height: 16px;
        font-size: 16px;
      }
    }

    .tab:hover {
      background: color-mix(in srgb, var(--mat-sys-on-surface) 8%, transparent);
    }

    .tab.active {
      background: var(--mat-sys-secondary-container);
      color: var(--mat-sys-on-secondary-container);
    }

    .tab:focus-visible {
      outline: 2px solid var(--mat-sys-primary);
      outline-offset: -2px;
    }

    .counts {
      display: inline-flex;
      gap: 4px;
    }

    .count {
      display: inline-grid;
      place-items: center;
      min-width: 17px;
      height: 17px;
      padding: 0 4px;
      border-radius: 9px;
      font: var(--mat-sys-label-small);
    }

    .count.error {
      background: var(--mat-sys-error);
      color: var(--mat-sys-on-error);
    }

    .count.warning {
      background: var(--mat-sys-tertiary);
      color: var(--mat-sys-on-tertiary);
    }

    .spacer {
      flex: 1;
    }

    .action,
    .detach,
    .close {
      width: 28px;
      height: 28px;
      padding: 4px;

      mat-icon {
        width: 18px;
        height: 18px;
        font-size: 18px;
      }
    }

    .body {
      position: relative;
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }

    /*
     * Not \`.tabpanel { display: flex }\`: an author rule's \`display\` always
     * wins over the UA stylesheet's \`[hidden] { display: none }\` regardless of
     * specificity, so an unconditional \`display: flex\` here would render both
     * tabpanels at once, stacked, whichever one is \`hidden\`. Scoping the rule to
     * \`:not([hidden])\` leaves the hidden one with no author rule to override the
     * default.
     */
    .tabpanel:not([hidden]) {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
`;
