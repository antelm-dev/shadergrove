/**
 * Turns a `401` from the API into a sign-in prompt instead of an error the user
 * has to decode.
 *
 * It re-resolves the session first — a `401` usually means the session expired
 * or was revoked from another device, and the in-memory state still claims
 * otherwise. The prompt is a dialog rather than a route change on purpose: the
 * editor keeps its unsaved shader, and the user returns to exactly the document
 * they were in the middle of.
 */

import { isPlatformBrowser } from '@angular/common';
import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { PLATFORM_ID, inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';

import { AuthService } from './auth.service';
import { AuthPrompt } from './auth-prompt';

export const authInterceptor: HttpInterceptorFn = (request, next) => {
  // The server renders every page anonymously (see `App`), so its `401`s are
  // expected, not a lapsed session. A prompt opened there is shipped as inert
  // markup whose backdrop covers the hydrated page, signed-in user or not.
  if (!isPlatformBrowser(inject(PLATFORM_ID))) return next(request);

  const auth = inject(AuthService);
  const prompt = inject(AuthPrompt);
  const router = inject(Router);

  return next(request).pipe(
    catchError((error: unknown) => {
      // Only the app's own API. A 401 from somewhere else is not ours to
      // interpret, and the auth endpoints answer 401 as part of normal use.
      const ours = request.url.includes('/api/') && !request.url.includes('/api/auth/');
      // Explore is for visitors without an account too. The editor underneath
      // it still asks for the (private) library and is refused, and that must
      // not put a sign-in dialog in front of someone who only came to look;
      // the Explore pages ask for a session themselves, when an action needs one.
      const browsing = /^\/explore(?:[/?#]|$)/.test(router.url);
      if (error instanceof HttpErrorResponse && error.status === 401 && ours && !browsing) {
        void auth.refresh().then(() => prompt.requestSignIn());
      }
      return throwError(() => error);
    }),
  );
};
