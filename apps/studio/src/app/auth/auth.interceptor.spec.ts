import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authInterceptor } from './auth.interceptor';
import { AuthPrompt } from './auth-prompt';
import { AuthService } from './auth.service';

function setUp(platform: 'browser' | 'server') {
  const refresh = vi.fn(() => Promise.resolve());
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptors([authInterceptor])),
      provideHttpClientTesting(),
      provideRouter([]),
      { provide: PLATFORM_ID, useValue: platform },
      { provide: AuthService, useValue: { refresh } },
    ],
  });
  return {
    refresh,
    http: TestBed.inject(HttpClient),
    backend: TestBed.inject(HttpTestingController),
    prompt: TestBed.inject(AuthPrompt),
  };
}

async function refuse({ http, backend }: ReturnType<typeof setUp>): Promise<void> {
  const request = firstValueFrom(http.get('/api/shaders')).catch(() => undefined);
  backend.expectOne('/api/shaders').flush(null, { status: 401, statusText: 'Unauthorized' });
  await request;
  await Promise.resolve();
}

describe('authInterceptor', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('asks for a sign-in when the API refuses the browser', async () => {
    const setup = setUp('browser');
    await refuse(setup);
    expect(setup.refresh).toHaveBeenCalledOnce();
    expect(setup.prompt.pending()).toEqual({ mode: 'sign-in' });
  });

  it('leaves the anonymous server render alone, so no dialog ships in its HTML', async () => {
    const setup = setUp('server');
    await refuse(setup);
    expect(setup.refresh).not.toHaveBeenCalled();
    expect(setup.prompt.pending()).toBeNull();
  });
});
