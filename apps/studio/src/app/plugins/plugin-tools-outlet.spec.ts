import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_RENDER } from '@shadergrove/shared/model';
import { migrateLegacyProject } from '@shadergrove/shared/project';
import { AuthService } from '../auth/auth.service';
import { DesktopPlatform } from '../desktop/desktop-platform';
import { ShaderStore } from '../workspace/shader-store';
import { PLUGIN_STORE, PluginInstallations } from './plugin-installations';
import type { StoredPlugin } from './plugin-store';
import { PluginTools, TOOL_ADAPTERS, type ToolSession } from './plugin-tools';
import { PluginToolsOutlet } from './plugin-tools-outlet';
import {
  TOOLS_PACKAGE_ID,
  testAnalyzerAdapter,
  testTextureAdapter,
  toolsPackageText,
} from './testing/tool-fixtures';

/**
 * The generic Installed-card outlet: host-registered panels, one session per
 * install, nothing for a package that is off, updated away or removed.
 */
describe('PluginToolsOutlet', () => {
  let records: Map<string, StoredPlugin>;

  function setup(packageId = TOOLS_PACKAGE_ID) {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: PLUGIN_STORE,
          useValue: () => ({
            list: async () => [...records.values()],
            put: async (stored: StoredPlugin) => void records.set(stored.id, stored),
            remove: async (id: string) => void records.delete(id),
            replace: async (stored: StoredPlugin) =>
              records.get(stored.id)?.installedAt === stored.installedAt
                ? (records.set(stored.id, stored), true)
                : false,
            readBootstrap: async () => null,
            writeBootstrap: async () => undefined,
          }),
        },
        { provide: AuthService, useValue: { user: signal(null), status: signal('anonymous') } },
        { provide: DesktopPlatform, useValue: { available: false } },
        {
          provide: ShaderStore,
          useValue: {
            selectedId: signal('waves'),
            draft: signal({
              project: migrateLegacyProject('void main() {}', 'void main() {}'),
              render: DEFAULT_RENDER,
            }),
            controls: signal([]),
            params: signal({}),
            record: signal({ id: 'waves', name: 'Waves' }),
          },
        },
        { provide: TOOL_ADAPTERS, useValue: testAnalyzerAdapter, multi: true },
        { provide: TOOL_ADAPTERS, useValue: testTextureAdapter, multi: true },
      ],
    });
    const installations = TestBed.inject(PluginInstallations);
    const tools = TestBed.inject(PluginTools);
    const sessions: ToolSession[] = [];
    const open = tools.openSession.bind(tools);
    vi.spyOn(tools, 'openSession').mockImplementation((...args) => {
      const session = open(...args);
      if (session) sessions.push(session);
      return session;
    });
    const fixture = TestBed.createComponent(PluginToolsOutlet);
    fixture.componentRef.setInput('packageId', packageId);
    return { fixture, installations, sessions };
  }

  async function settle(fixture: { detectChanges(): void }): Promise<void> {
    TestBed.tick();
    for (let i = 0; i < 6; i++) await Promise.resolve();
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();
  }

  async function install(installations: PluginInstallations, text = toolsPackageText()) {
    TestBed.tick(); // the profile's store opens on the first tick
    await Promise.resolve();
    const review = installations.review(new TextEncoder().encode(text));
    if (!review.ok) throw new Error(review.errors.join());
    await installations.install(review);
    await installations.setEnabled(review.plugin.manifest.id, true);
  }

  const panels = (root: HTMLElement) =>
    [...root.querySelectorAll('[data-testid^="plugin-tool-"]')].map((node) =>
      node.getAttribute('data-testid'),
    );

  beforeEach(() => {
    records = new Map();
  });
  afterEach(() => TestBed.resetTestingModule());

  it('draws the host adapter panel of each active, registered tool with its session', async () => {
    const { fixture, installations, sessions } = setup();
    await settle(fixture);
    expect(panels(fixture.nativeElement)).toEqual([]);

    await install(installations);
    await settle(fixture);
    expect(panels(fixture.nativeElement)).toEqual([
      `plugin-tool-${TOOLS_PACKAGE_ID}/doctor`,
      `plugin-tool-${TOOLS_PACKAGE_ID}/pack`,
    ]);
    // The panel received its session: it prints the package and contribution it is for.
    expect(
      fixture.nativeElement.querySelector('[data-testid="analyzer-panel"]').textContent,
    ).toContain(`${TOOLS_PACKAGE_ID}/doctor`);
    expect(
      fixture.nativeElement.querySelector('[data-testid="asset-panel"]').textContent,
    ).toContain('pack');
    expect(sessions.map((session) => session.contributionId)).toEqual(['doctor', 'pack']);
  });

  it('draws nothing for another package', async () => {
    const { fixture, installations } = setup('dev.example.other');
    await install(installations);
    await settle(fixture);
    expect(panels(fixture.nativeElement)).toEqual([]);
  });

  it('removes the panels and closes their sessions when the package is switched off', async () => {
    const { fixture, installations, sessions } = setup();
    await install(installations);
    await settle(fixture);
    expect(panels(fixture.nativeElement)).toHaveLength(2);

    await installations.setEnabled(TOOLS_PACKAGE_ID, false);
    await settle(fixture);
    expect(panels(fixture.nativeElement)).toEqual([]);
    for (const session of sessions) {
      expect((await session.analyze('studio-webgl2/v1', {} as never)).status).toMatch(/cancelled/);
    }
  });

  it('gives an updated package new sessions and closes the old ones', async () => {
    const { fixture, installations, sessions } = setup();
    await install(installations);
    await settle(fixture);
    expect(sessions).toHaveLength(2);

    const update = installations.review(
      new TextEncoder().encode(toolsPackageText({ version: '1.0.1' })),
    );
    if (!update.ok) throw new Error(update.errors.join());
    await installations.installReviewedUpdate(update);
    await installations.setEnabled(TOOLS_PACKAGE_ID, true);
    await settle(fixture);

    expect(panels(fixture.nativeElement)).toHaveLength(2);
    expect(sessions).toHaveLength(4);
    expect((await sessions[0]!.analyze('studio-webgl2/v1', {} as never)).status).toBe('cancelled');
  });

  it('closes every session when the card is destroyed', async () => {
    const { fixture, installations, sessions } = setup();
    await install(installations);
    await settle(fixture);
    fixture.destroy();
    for (const session of sessions) {
      expect((await session.analyze('studio-webgl2/v1', {} as never)).status).toBe('cancelled');
    }
  });
});
