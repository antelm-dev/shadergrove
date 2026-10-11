import { RenderMode, ServerRoute } from '@angular/ssr';

/**
 * Server-rendered rather than prerendered: the page reflects whatever shaders
 * are on disk right now, and those change while the app is running.
 */
export const serverRoutes: ServerRoute[] = [
  // The email links. Their guards read the token, open the auth dialog and
  // redirect to `/`; run on the server, that redirect becomes an HTTP 302 that
  // drops the token before the browser ever sees it. So these get the client
  // shell, and the guard runs where the dialog lives.
  { path: 'reset-password', renderMode: RenderMode.Client },
  { path: 'verify-email', renderMode: RenderMode.Client },
  {
    path: '**',
    renderMode: RenderMode.Server,
  },
];
