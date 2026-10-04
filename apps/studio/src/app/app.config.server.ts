import { ApplicationConfig, REQUEST, mergeApplicationConfig } from '@angular/core';
import { provideServerRendering, withRoutes } from '@angular/ssr';

import { API_BASE_URL } from './api/api-base-url';
import { appConfig } from './app.config';
import { serverRoutes } from './app.routes.server';

const serverConfig: ApplicationConfig = {
  providers: [
    provideServerRendering(withRoutes(serverRoutes)),
    {
      provide: API_BASE_URL,
      useFactory: (request: Request | null) =>
        request ? new URL(request.url).origin : `http://localhost:${process.env['PORT'] ?? 4200}`,
      deps: [REQUEST],
    },
  ],
};

export const config = mergeApplicationConfig(appConfig, serverConfig);
