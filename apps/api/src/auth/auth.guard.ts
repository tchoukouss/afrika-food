import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { requestContext } from '../common/request-context';
import { env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { AccessService } from './access.service';
import { IS_PUBLIC, PERMISSION_SCOPE, REQUIRED_PERMISSIONS } from './decorators';

export interface AccessTokenPayload {
  sub: string;
  cid: string;
  sid: string;
}

export const ALLOW_PENDING_PASSWORD = 'allowPendingPassword';
/** Route utilisable même si l'utilisateur doit encore changer son mot de passe. */
export const AllowPendingPassword = () => SetMetadata(ALLOW_PENDING_PASSWORD, true);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Garde global : authentification, contexte établissement et permissions.
// Toute route est protégée par défaut ; @Public() l'ouvre explicitement.
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly accessService: AccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const payload = await this.verifyToken(req);

    const [session, user] = await Promise.all([
      this.prisma.loginSession.findUnique({ where: { id: payload.sid } }),
      this.prisma.user.findUnique({ where: { id: payload.sub } }),
    ]);
    if (!session || session.revokedAt || session.expiresAt < new Date() || session.userId !== payload.sub) {
      throw new UnauthorizedException('Session expirée ou révoquée');
    }
    if (!user || !user.isActive || user.deletedAt || user.companyId !== payload.cid) {
      throw new UnauthorizedException('Compte désactivé');
    }
    if (user.mustChangePassword && !this.reflector.getAllAndOverride<boolean>(ALLOW_PENDING_PASSWORD, targets)) {
      throw new ForbiddenException({ message: 'Vous devez changer votre mot de passe', code: 'PASSWORD_CHANGE_REQUIRED' });
    }

    const access = await this.accessService.load(user.id, user.companyId);

    const header = req.headers['x-establishment-id'];
    const establishmentId = typeof header === 'string' && header !== '' ? header : undefined;
    if (establishmentId) {
      if (!UUID_RE.test(establishmentId) || !access.canAccessEstablishment(establishmentId)) {
        throw new ForbiddenException("Accès refusé à cet établissement");
      }
    }

    const ctx = requestContext.get();
    Object.assign(ctx, {
      userId: user.id,
      companyId: user.companyId,
      sessionId: session.id,
      establishmentId,
      access,
    });

    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_PERMISSIONS, targets) ?? [];
    if (required.length === 0) return true;

    const scope = this.reflector.getAllAndOverride<string>(PERMISSION_SCOPE, targets);
    let allowed: boolean;
    if (scope === 'group') {
      allowed = required.every((p) => access.global.has(p));
    } else if (scope === 'any' && !establishmentId) {
      allowed = required.every((p) => access.global.has(p) || access.establishmentsWith(p).length > 0);
    } else {
      allowed = required.every((p) => access.can(p, establishmentId));
    }
    if (!allowed) {
      throw new ForbiddenException("Vous n'avez pas la permission d'effectuer cette action");
    }
    return true;
  }

  private async verifyToken(req: Request): Promise<AccessTokenPayload> {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) throw new UnauthorizedException('Authentification requise');
    try {
      return await this.jwt.verifyAsync<AccessTokenPayload>(auth.slice(7), {
        secret: env().jwtAccessSecret,
        algorithms: ['HS256'],
      });
    } catch {
      throw new UnauthorizedException('Jeton invalide ou expiré');
    }
  }
}
