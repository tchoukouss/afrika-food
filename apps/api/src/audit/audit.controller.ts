import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { AnyEstablishmentScope, AuthUser, CurrentUser, RequirePermissions } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';

class AuditQuery {
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @IsString() entityType?: string;
  @IsOptional() @IsString() entityId?: string;
  @IsOptional() @IsString() action?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize = 50;
}

class SecurityQuery {
  @IsOptional() @IsString() type?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize = 50;
}

// Lecture seule : aucune route ne modifie ni ne supprime le journal.
@ApiTags('Audit')
@ApiBearerAuth()
@Controller()
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('audit-logs')
  @RequirePermissions('audit.view')
  @AnyEstablishmentScope()
  async list(@CurrentUser() me: AuthUser, @Query() q: AuditQuery) {
    // Accès groupe : tout le journal. Sinon : uniquement les établissements
    // où l'utilisateur a la permission (pas les entrées de niveau groupe).
    const scoped = me.establishmentId
      ? { establishmentId: me.establishmentId }
      : me.access.global.has('audit.view')
        ? {}
        : { establishmentId: { in: me.access.establishmentsWith('audit.view') } };

    const where = {
      companyId: me.companyId,
      ...scoped,
      userId: q.userId,
      entityType: q.entityType,
      entityId: q.entityId,
      action: q.action ? { contains: q.action } : undefined,
      createdAt: q.from || q.to ? { gte: q.from ? new Date(q.from) : undefined, lte: q.to ? new Date(q.to) : undefined } : undefined,
    };
    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: {
          user: { select: { id: true, fullName: true, email: true } },
          establishment: { select: { id: true, name: true } },
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  @Get('security-events')
  @RequirePermissions('security.view')
  async security(@CurrentUser() me: AuthUser, @Query() q: SecurityQuery) {
    const where = {
      type: q.type,
      // Événements liés aux utilisateurs de l'entreprise, ou sans utilisateur identifié.
      OR: [{ user: { companyId: me.companyId } }, { userId: null }],
    };
    const [items, total] = await Promise.all([
      this.prisma.securityEvent.findMany({
        where,
        orderBy: { id: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { user: { select: { id: true, fullName: true, email: true } } },
      }),
      this.prisma.securityEvent.count({ where }),
    ]);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }
}
