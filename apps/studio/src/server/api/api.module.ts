import {
  Module,
  type DynamicModule,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import type { ShaderLibrary } from '@shadergrove/backend/library';

import { AdminModule } from './admin/admin.module';
import type { Auditor } from './auth/audit';
import { consoleAuditor } from './auth/audit';
import type { Auth } from './auth/auth';
import { AuthModule } from './auth/auth.module';
import { CoreModule } from './core/core.module';
import { RequestLogger } from './core/logger';
import { EXPLORE_OFF, type Explore } from './publications/explore';
import { PublicationsModule } from './publications/publications.module';
import { ShadersModule } from './shaders/shaders.module';
import { SystemModule } from './system/system.module';
import { ReleasesModule } from './releases/releases.module';

/**
 * The whole API: `CoreModule` provides what every feature injects (the library,
 * Better Auth, the auditor, Explore) and the global guard; each feature module
 * only declares its routes.
 */
@Module({})
export class ApiModule implements NestModule {
  static forLibrary(
    library: ShaderLibrary,
    auth: Auth,
    auditor: Auditor = consoleAuditor,
    explore: Explore = EXPLORE_OFF,
  ): DynamicModule {
    const exploreOn = Boolean(explore.publications);
    return {
      module: ApiModule,
      imports: [
        CoreModule.forRoot({ library, auth, auditor, explore }),
        SystemModule,
        ReleasesModule,
        ShadersModule,
        AuthModule,
        PublicationsModule.register({ exploreOn }),
        // Not registered at all while Explore is off: the routes do not exist,
        // rather than existing and refusing.
        ...(exploreOn ? [AdminModule] : []),
      ],
      providers: [RequestLogger],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestLogger).forRoutes('{*path}');
  }
}
