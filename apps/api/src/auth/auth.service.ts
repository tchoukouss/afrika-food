import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { requestContext } from '../common/request-context';
import { env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { AccessService } from './access.service';
import { AccessTokenPayload } from './auth.guard';
import { assertPasswordPolicy, hashPassword, verifyPassword } from './password';

const INVALID_CREDENTIALS = 'Email ou mot de passe incorrect';

function sha256(value: string) {
  return createHash('sha256').update(value).digest();
}

export interface IssuedTokens {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
}

@Injectable()
export class AuthService {
  // Hash factice pour que la durée de réponse ne révèle pas si un email existe.
  private dummyHash: Promise<string> = hashPassword('dummy-password-0');

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
  ) {}

  async login(emailInput: string, password: string): Promise<IssuedTokens & { userId: string }> {
    const email = emailInput.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user || user.deletedAt) {
      await verifyPassword(await this.dummyHash, password);
      await this.audit.securityEvent('LOGIN_FAILED', { email, details: { reason: 'UNKNOWN_EMAIL' } });
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.audit.securityEvent('LOGIN_WHILE_LOCKED', { userId: user.id, email });
      const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
      throw new UnauthorizedException(`Compte temporairement verrouillé. Réessayez dans ${minutes} min.`);
    }

    const valid = await verifyPassword(user.passwordHash, password);
    if (!valid) {
      await this.registerFailure(user.id, email);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    if (!user.isActive) {
      await this.audit.securityEvent('LOGIN_FAILED', { userId: user.id, email, details: { reason: 'INACTIVE' } });
      throw new UnauthorizedException('Compte désactivé. Contactez un administrateur.');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    const tokens = await this.createSession(user.id, user.companyId);
    await this.audit.record({
      action: 'LOGIN',
      entityType: 'User',
      entityId: user.id,
      companyId: user.companyId,
      userId: user.id,
      establishmentId: null,
    });
    await this.audit.securityEvent('LOGIN_SUCCESS', { userId: user.id, email });
    return { ...tokens, userId: user.id };
  }

  private async registerFailure(userId: string, email: string) {
    const { maxFailedLogins, lockoutMinutes } = env();
    // Incrément atomique : plusieurs tentatives simultanées sont toutes comptées.
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });
    await this.audit.securityEvent('LOGIN_FAILED', { userId, email, details: { reason: 'BAD_PASSWORD', attempt: updated.failedLoginCount } });
    if (updated.failedLoginCount >= maxFailedLogins) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { lockedUntil: new Date(Date.now() + lockoutMinutes * 60000), failedLoginCount: 0 },
      });
      await this.audit.securityEvent('ACCOUNT_LOCKED', { userId, email, details: { minutes: lockoutMinutes } });
    }
  }

  private async createSession(userId: string, companyId: string): Promise<IssuedTokens> {
    const ctx = requestContext.get();
    const token = randomBytes(48).toString('base64url');
    const refreshExpiresAt = new Date(Date.now() + env().refreshTokenTtlDays * 86400000);
    const session = await this.prisma.loginSession.create({
      data: {
        userId,
        refreshTokenHash: sha256(token).toString('hex'),
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
        expiresAt: refreshExpiresAt,
      },
    });
    ctx.sessionId = session.id;
    return {
      accessToken: await this.signAccess({ sub: userId, cid: companyId, sid: session.id }),
      expiresIn: env().accessTokenTtlSeconds,
      refreshToken: `${session.id}.${token}`,
      refreshExpiresAt,
    };
  }

  private signAccess(payload: AccessTokenPayload) {
    return this.jwt.signAsync(payload, {
      secret: env().jwtAccessSecret,
      expiresIn: env().accessTokenTtlSeconds,
      algorithm: 'HS256',
    });
  }

  /** Renouvelle le jeton d'accès et fait tourner le jeton de rafraîchissement. */
  async refresh(cookieValue: string | undefined): Promise<IssuedTokens> {
    const [sessionId, token] = (cookieValue ?? '').split('.');
    if (!sessionId || !token || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
      throw new UnauthorizedException('Session expirée');
    }
    const session = await this.prisma.loginSession.findUnique({
      where: { id: sessionId },
      include: { user: true },
    });
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      throw new UnauthorizedException('Session expirée');
    }

    const expected = Buffer.from(session.refreshTokenHash, 'hex');
    const provided = sha256(token);
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      // Un ancien jeton réutilisé peut signifier un vol : on coupe la session.
      await this.prisma.loginSession.update({
        where: { id: session.id },
        data: { revokedAt: new Date(), revokedReason: 'REFRESH_TOKEN_REUSE' },
      });
      await this.audit.securityEvent('REFRESH_TOKEN_REUSE', { userId: session.userId });
      throw new UnauthorizedException('Session expirée');
    }

    const user = session.user;
    if (!user.isActive || user.deletedAt) {
      throw new UnauthorizedException('Compte désactivé');
    }

    const newToken = randomBytes(48).toString('base64url');
    const refreshExpiresAt = new Date(Date.now() + env().refreshTokenTtlDays * 86400000);
    // Mise à jour conditionnelle : si deux rafraîchissements arrivent en même
    // temps avec le même jeton, un seul réussit.
    const { count } = await this.prisma.loginSession.updateMany({
      where: { id: session.id, refreshTokenHash: session.refreshTokenHash, revokedAt: null },
      data: { refreshTokenHash: sha256(newToken).toString('hex'), lastUsedAt: new Date(), expiresAt: refreshExpiresAt },
    });
    if (count === 0) throw new UnauthorizedException('Session expirée');

    return {
      accessToken: await this.signAccess({ sub: user.id, cid: user.companyId, sid: session.id }),
      expiresIn: env().accessTokenTtlSeconds,
      refreshToken: `${session.id}.${newToken}`,
      refreshExpiresAt,
    };
  }

  async logout(sessionId: string) {
    await this.prisma.loginSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'LOGOUT' },
    });
    await this.audit.record({ action: 'LOGOUT', entityType: 'User', entityId: requestContext.get().userId, establishmentId: null });
  }

  async changePassword(userId: string, sessionId: string, currentPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await verifyPassword(user.passwordHash, currentPassword))) {
      await this.audit.securityEvent('PASSWORD_CHANGE_FAILED', { userId });
      throw new BadRequestException('Mot de passe actuel incorrect');
    }
    assertPasswordPolicy(newPassword);
    if (currentPassword === newPassword) {
      throw new BadRequestException("Le nouveau mot de passe doit être différent de l'ancien");
    }
    const passwordHash = await hashPassword(newPassword);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash, mustChangePassword: false, passwordChangedAt: new Date() },
      });
      // Les autres appareils connectés doivent se reconnecter.
      await tx.loginSession.updateMany({
        where: { userId, revokedAt: null, id: { not: sessionId } },
        data: { revokedAt: new Date(), revokedReason: 'PASSWORD_CHANGED' },
      });
      await this.audit.record({ action: 'PASSWORD_CHANGED', entityType: 'User', entityId: userId, establishmentId: null }, tx);
    });
  }

  /** Profil, établissements accessibles et permissions de l'utilisateur connecté. */
  async me(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { company: true },
    });
    const access = await this.access.load(user.id, user.companyId);
    const establishments = await this.prisma.establishment.findMany({
      where: { id: { in: access.establishmentIds } },
      orderBy: { name: 'asc' },
      select: { id: true, code: true, name: true, type: true, city: true },
    });
    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      phone: user.phone,
      mustChangePassword: user.mustChangePassword,
      company: { id: user.company.id, name: user.company.name, currency: user.company.currency, logoUrl: user.company.logoUrl },
      globalPermissions: [...access.global].sort(),
      establishments: establishments.map((e) => ({
        ...e,
        permissions: [...access.permissionsIn(e.id)].sort(),
      })),
    };
  }
}
