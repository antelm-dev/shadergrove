import { Location } from '@angular/common';
import { provideLocationMocks } from '@angular/common/testing';
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import { AuthService } from '../auth/auth.service';
import { I18n } from '../i18n/i18n';
import { WorkspaceActions } from '../ui/workspace-actions';
import { RoutingCoordinator } from './routing-coordinator';
import { ShaderStore } from './shader-store';

@Component({ template: '' })
class Blank {}

/** `cold`: the page was opened at `url`, but the router has not navigated yet, as on a real startup. */
async function setup(url: string, { cold = false } = {}) {
  const selectedId = signal<string | null>(null);
  const requested: (string | null | undefined)[] = [];
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([{ path: '**', component: Blank }]),
      provideLocationMocks(),
      {
        provide: ShaderStore,
        useValue: {
          selectedId,
          shaders: signal([{ id: 'waves' }, { id: 'plasma' }]),
          notice: signal(null),
          initializeClient: async (id?: string | null) => {
            requested.push(id);
            if (id) selectedId.set(id);
          },
        },
      },
      {
        provide: WorkspaceActions,
        useValue: {
          selectShader: async () => true,
          resolveStaleRecovery: async () => undefined,
          resolveFirstRunMigration: async () => undefined,
        },
      },
      { provide: I18n, useValue: { t: (key: string) => key } },
      { provide: AuthService, useValue: { status: signal('loading'), user: signal(null) } },
    ],
  });
  const router = TestBed.inject(Router);
  if (cold) TestBed.inject(Location).go(url);
  else await router.navigateByUrl(url);
  const coordinator = TestBed.inject(RoutingCoordinator);
  // `afterNextRender` never fires without a view; start routing the way it would.
  await (coordinator as unknown as { initializeRouting(): Promise<void> }).initializeRouting();
  return { router, selectedId, requested };
}

const settle = async () => {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
};

describe('RoutingCoordinator', () => {
  it('normalizes an unknown path to the selection', async () => {
    const { router } = await setup('/somewhere');
    expect(router.url).toBe('/');
  });

  it('opens the deep-linked shader when startup runs before the initial navigation', async () => {
    const { router, requested } = await setup('/shaders/plasma', { cold: true });
    expect(requested).toEqual(['plasma']);
    expect(router.url).toBe('/shaders/plasma');
  });

  it('leaves the desktop sign-in page alone, through startup and a selection', async () => {
    const url = '/desktop/connect?state=af0ifjsldkj-state_1&code_challenge=abc';
    const { router, selectedId } = await setup(url);
    expect(router.url).toBe(url);

    selectedId.set('waves');
    await settle();
    expect(router.url).toBe(url);
  });

  it('leaves the Explore and moderation pages alone while the selection changes under them', async () => {
    for (const url of ['/explore', '/explore/0123456789abcdef0123', '/admin/publications']) {
      const { router, selectedId } = await setup(url);
      expect(router.url).toBe(url);

      selectedId.set('waves');
      await settle();
      expect(router.url).toBe(url);

      // Leaving is an ordinary navigation: the editor's URL follows the selection again.
      await router.navigateByUrl('/');
      await settle();
      expect(router.url).toBe('/shaders/waves');
      TestBed.resetTestingModule();
    }
  });
});
