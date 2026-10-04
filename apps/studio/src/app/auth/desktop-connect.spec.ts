import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import {
  ActivatedRoute,
  UrlTree,
  convertToParamMap,
  type ActivatedRouteSnapshot,
  type RouterStateSnapshot,
} from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { I18n } from '../i18n/i18n';
import { provideTestLanguages } from '../i18n/testing/languages';
import { Preferences } from '../prefs/preferences';
import { AuthService, type AuthStatus } from './auth.service';
import { DesktopConnect, desktopConnectLink } from './desktop-connect';

const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const STATE = 'af0ifjsldkj-state_1';

function admits(query: Record<string, string>): boolean {
  const route = { queryParamMap: convertToParamMap(query) } as ActivatedRouteSnapshot;
  const result = TestBed.runInInjectionContext(() =>
    desktopConnectLink(route, {} as RouterStateSnapshot),
  );
  return !(result instanceof UrlTree);
}

describe('desktopConnectLink', () => {
  it('admits a well-formed state and S256 challenge', () => {
    expect(admits({ state: STATE, code_challenge: CHALLENGE })).toBe(true);
  });

  it('sends anything else back to the app', () => {
    expect(admits({ code_challenge: CHALLENGE })).toBe(false);
    expect(admits({ state: STATE })).toBe(false);
    expect(admits({ state: 'short', code_challenge: CHALLENGE })).toBe(false);
    expect(admits({ state: `${STATE}<script>`, code_challenge: CHALLENGE })).toBe(false);
    expect(admits({ state: STATE, code_challenge: `${CHALLENGE}=` })).toBe(false);
    expect(admits({ state: STATE, code_challenge: 'plain-verifier' })).toBe(false);
  });
});

describe('DesktopConnect', () => {
  const status = signal<AuthStatus>('error');
  const verified = signal(false);
  const auth = {
    status,
    verified,
    // The server answers this time: the session resolves as signed in.
    refresh: vi.fn(async () => {
      status.set('authenticated');
      verified.set(true);
    }),
  };

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  async function mount(): Promise<ComponentFixture<DesktopConnect>> {
    TestBed.configureTestingModule({
      imports: [DesktopConnect],
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        I18n,
        provideTestLanguages(),
        { provide: Preferences, useValue: { value: signal({ language: 'en' }) } },
        { provide: AuthService, useValue: auth },
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              queryParamMap: convertToParamMap({ state: STATE, code_challenge: CHALLENGE }),
            },
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(DesktopConnect);
    await settle(fixture);
    return fixture;
  }

  async function settle(fixture: ComponentFixture<DesktopConnect>): Promise<void> {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function button(fixture: ComponentFixture<DesktopConnect>, label: string): HTMLButtonElement {
    const found = [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    expect(found, `button "${label}"`).toBeTruthy();
    return found!;
  }

  it('retries an unreachable session, then asks for the password before connecting', async () => {
    const fixture = await mount();
    const root = fixture.nativeElement as HTMLElement;
    expect(auth.refresh).not.toHaveBeenCalled();

    button(fixture, 'Try again').click();
    await settle(fixture);
    expect(auth.refresh).toHaveBeenCalledTimes(1);
    expect(root.textContent).toContain('Confirm your password to connect Shadergrove Desktop.');

    const input = root.querySelector<HTMLInputElement>('input[type="password"]')!;
    input.value = 'correct horse battery staple';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    button(fixture, 'Connect').click();

    const request = TestBed.inject(HttpTestingController).expectOne('/api/desktop/handoff');
    expect(request.request.body).toEqual({
      codeChallenge: CHALLENGE,
      password: 'correct horse battery staple',
    });
    request.flush(
      { error: { code: 'invalid', message: 'Check your password and try again' } },
      { status: 400, statusText: 'Bad Request' },
    );
    await settle(fixture);

    expect(root.textContent).toContain('Check your password and try again.');
    // The password does not outlive the request.
    expect(root.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe('');
  });
});
