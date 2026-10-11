import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './app';
import { rootComponent } from './root-component';
import { BottomPanelWindow } from './ui/bottom-panel/bottom-panel-window';
import { InspectorSession } from './ui/inspector/inspector-session';
import { InspectorWindow } from './ui/inspector/inspector-window';
import { RemoteInspectorSession } from './ui/inspector/remote-inspector-session';

describe('rootComponent', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    history.replaceState(null, '', '/');
  });

  it("boots a panel's own shell, never the workspace, in its native window", async () => {
    vi.stubGlobal('electron', {});

    history.replaceState(null, '', '/bottom-panel');
    expect((await rootComponent()).component).toBe(BottomPanelWindow);

    history.replaceState(null, '', '/inspector');
    const inspector = await rootComponent();
    expect(inspector.component).toBe(InspectorWindow);
    // At the application level, so a dialog the inspector opens gets the mirror too.
    expect(inspector.providers).toContainEqual({
      provide: InspectorSession,
      useExisting: RemoteInspectorSession,
    });
  });

  it('boots the workspace everywhere else, and on the web whatever the path', async () => {
    vi.stubGlobal('electron', {});
    history.replaceState(null, '', '/output');
    expect(await rootComponent()).toEqual({ component: App, providers: [] });

    vi.unstubAllGlobals();
    for (const path of ['/bottom-panel', '/inspector', '/editor']) {
      history.replaceState(null, '', path);
      expect((await rootComponent()).component).toBe(App);
    }
  });
});
