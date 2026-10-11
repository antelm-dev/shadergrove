import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './app';
import { rootComponent } from './root-component';
import { BottomPanelWindow } from './ui/bottom-panel/bottom-panel-window';

describe('rootComponent', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    history.replaceState(null, '', '/');
  });

  it('boots the bottom-panel shell, never the workspace, in its native window', async () => {
    vi.stubGlobal('electron', {});
    history.replaceState(null, '', '/bottom-panel');

    expect(await rootComponent()).toBe(BottomPanelWindow);
  });

  it('boots the workspace everywhere else, and on the web whatever the path', async () => {
    vi.stubGlobal('electron', {});
    history.replaceState(null, '', '/output');
    expect(await rootComponent()).toBe(App);

    vi.unstubAllGlobals();
    history.replaceState(null, '', '/bottom-panel');
    expect(await rootComponent()).toBe(App);
  });
});
