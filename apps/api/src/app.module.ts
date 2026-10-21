import { Controller, Get, MiddlewareConsumer, Module, NestModule, ServiceUnavailableException } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ApiTags } from '@nestjs/swagger';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuditController } from './audit/audit.controller';
import { AuditService } from './audit/audit.service';
import { AccessService } from './auth/access.service';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { Public } from './auth/decorators';
import { PrismaExceptionFilter } from './common/prisma-exception.filter';
import { RequestContextMiddleware } from './common/request-context.middleware';
import { CatalogModule } from './catalog/catalog.module';
import { CompanyController, CompanyService } from './company/company';
import { EstablishmentsController, EstablishmentsService } from './establishments/establishments';
import { PrismaModule, PrismaService } from './prisma/prisma.service';
import { RolesController, RolesService } from './roles/roles';
import { SequenceService } from './sequences/sequence.service';
import { UsersController, UsersService } from './users/users';

@ApiTags('Système')
@Controller('health')
class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  async check() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', database: 'ok', time: new Date().toISOString() };
    } catch {
      throw new ServiceUnavailableException({ status: 'error', database: 'unreachable' });
    }
  }
}

@Module({
  imports: [
    PrismaModule,
    CatalogModule,
    JwtModule.register({}),
    // Limite globale par IP ; des limites plus strictes s'appliquent à la connexion.
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 600 }],
      // Désactivable uniquement pour les tests automatisés (nombreuses connexions depuis la même IP).
      skipIf: () => process.env.DISABLE_THROTTLE === 'true' && process.env.NODE_ENV === 'test',
    }),
  ],
  controllers: [
    HealthController,
    AuthController,
    CompanyController,
    EstablishmentsController,
    UsersController,
    RolesController,
    AuditController,
  ],
  providers: [
    AccessService,
    AuditService,
    AuthService,
    SequenceService,
    CompanyService,
    EstablishmentsService,
    UsersService,
    RolesService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: PrismaExceptionFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestContextMiddleware).forRoutes('*path');
  }
}
