import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { AuditService, diff } from '../audit/audit.service';
import { AnyEstablishmentScope, AuthUser, CurrentUser, RequirePermissions } from '../auth/decorators';
import { assertPasswordPolicy, hashPassword } from '../auth/password';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { ensureAdministratorRemains } from '../roles/roles';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

export class RoleAssignmentDto {
  @IsUUID() roleId: string;
  /** null = rôle valable dans tous les établissements. */
  @IsOptional() @IsUUID() establishmentId?: string | null;
}

export class CreateUserDto {
  @Transform(lower) @IsEmail({}, { message: 'Email invalide' }) @MaxLength(254) email: string;
  @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) fullName: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(40) phone?: string;
  /** Mot de passe provisoire : l'utilisateur devra le changer à la première connexion. */
  @IsString() @MaxLength(128) password: string;
  @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => RoleAssignmentDto) roles: RoleAssignmentDto[];
}

export class UpdateUserDto {
  @IsOptional() @Transform(lower) @IsEmail({}, { message: 'Email invalide' }) @MaxLength(254) email?: string;
  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(120) fullName?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

export class SetRolesDto {
  @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => RoleAssignmentDto) roles: RoleAssignmentDto[];
}

export class ResetPasswordDto {
  @IsString() @MaxLength(128) password: string;
}

const userSelect = {
  id: true,
  email: true,
  fullName: true,
  phone: true,
  isActive: true,
  mustChangePassword: true,
  lockedUntil: true,
  lastLoginAt: true,
  createdAt: true,
  userRoles: {
    select: {
      id: true,
      establishmentId: true,
      role: { select: { id: true, code: true, name: true } },
      establishment: { select: { id: true, code: true, name: true } },
    },
  },
} satisfies Prisma.UserSelect;

type Assignment = { roleId: string; establishmentId: string | null };
const key = (a: Assignment) => `${a.roleId}|${a.establishmentId ?? '*'}`;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Filtre de visibilité : groupe = tous ; sinon utilisateurs rattachés à mes établissements. */
  private visibleWhere(me: AuthUser): Prisma.UserWhereInput {
    const base: Prisma.UserWhereInput = { companyId: me.companyId, deletedAt: null };
    if (me.access.global.has('users.view')) return base;
    const ids = me.establishmentId ? [me.establishmentId] : me.access.establishmentsWith('users.view');
    return { ...base, userRoles: { some: { establishmentId: { in: ids } } } };
  }

  list(me: AuthUser) {
    return this.prisma.user.findMany({ where: this.visibleWhere(me), select: userSelect, orderBy: { fullName: 'asc' } });
  }

  async get(me: AuthUser, id: string) {
    const user = await this.prisma.user.findFirst({ where: { ...this.visibleWhere(me), id }, select: userSelect });
    if (!user) throw new NotFoundException('Utilisateur introuvable');
    return user;
  }

  /**
   * Un gestionnaire d'établissement ne peut gérer que les utilisateurs dont
   * tous les rôles sont dans des établissements où il a « users.manage ».
   * Un utilisateur de niveau groupe n'est gérable que depuis le niveau groupe.
   */
  private async assertCanManage(me: AuthUser, targetId: string, tx: Tx) {
    const target = await tx.user.findFirst({
      where: { id: targetId, companyId: me.companyId, deletedAt: null },
      include: { userRoles: true },
    });
    if (!target) throw new NotFoundException('Utilisateur introuvable');
    if (me.access.global.has('users.manage')) return target;
    const allowed = new Set(me.access.establishmentsWith('users.manage'));
    const ok = target.userRoles.length > 0 && target.userRoles.every((r) => r.establishmentId && allowed.has(r.establishmentId));
    if (!ok) throw new ForbiddenException("Vous ne pouvez pas gérer cet utilisateur");
    return target;
  }

  /** Contrôle qu'une attribution (ou un retrait) de rôle est permis à l'utilisateur courant. */
  private async assertCanAssign(me: AuthUser, assignments: Assignment[], tx: Tx) {
    if (assignments.length === 0) return;
    const roles = await tx.role.findMany({
      where: { id: { in: assignments.map((a) => a.roleId) }, companyId: me.companyId, deletedAt: null },
      include: { permissions: true },
    });
    const establishmentIds = [...new Set(assignments.map((a) => a.establishmentId).filter((e): e is string => !!e))];
    const establishments = await tx.establishment.count({
      where: { id: { in: establishmentIds }, companyId: me.companyId, deletedAt: null },
    });
    if (establishments !== establishmentIds.length) throw new BadRequestException('Établissement invalide');

    for (const a of assignments) {
      const role = roles.find((r) => r.id === a.roleId);
      if (!role) throw new BadRequestException('Rôle invalide');
      const scope = a.establishmentId ?? null;
      if (scope === null ? !me.access.global.has('users.manage') : !me.access.can('users.manage', scope)) {
        throw new ForbiddenException(
          scope === null
            ? 'Seul un gestionnaire de niveau groupe peut attribuer un rôle valable pour tous les établissements'
            : "Vous ne pouvez pas gérer les rôles de cet établissement",
        );
      }
      // Pas d'escalade : le rôle ne doit pas contenir de permission que l'on n'a pas dans ce périmètre.
      const mine = me.access.permissionsIn(scope);
      const missing = role.permissions.map((p) => p.permissionCode).filter((c) => !mine.has(c));
      if (missing.length) {
        throw new ForbiddenException(`Le rôle « ${role.name} » contient des permissions que vous n'avez pas`);
      }
    }
  }

  private normalize(list: RoleAssignmentDto[]): Assignment[] {
    const map = new Map<string, Assignment>();
    for (const r of list) {
      const a = { roleId: r.roleId, establishmentId: r.establishmentId ?? null };
      map.set(key(a), a);
    }
    return [...map.values()];
  }

  async create(me: AuthUser, dto: CreateUserDto) {
    assertPasswordPolicy(dto.password);
    const roles = this.normalize(dto.roles);
    if (roles.length === 0) throw new BadRequestException('Attribuez au moins un rôle');
    const passwordHash = await hashPassword(dto.password);
    return this.prisma.$transaction(async (tx) => {
      await this.assertCanAssign(me, roles, tx);
      const user = await tx.user.create({
        data: {
          companyId: me.companyId,
          email: dto.email,
          fullName: dto.fullName,
          phone: dto.phone,
          passwordHash,
          mustChangePassword: true,
          userRoles: { create: roles },
        },
        select: userSelect,
      });
      await this.audit.record(
        {
          action: 'USER_CREATED',
          entityType: 'User',
          entityId: user.id,
          establishmentId: null,
          newValues: { email: user.email, fullName: user.fullName, phone: user.phone, roles },
        },
        tx,
      );
      return user;
    });
  }

  async update(me: AuthUser, id: string, dto: UpdateUserDto) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${id}::uuid FOR UPDATE`;
      const target = await this.assertCanManage(me, id, tx);
      if (id === me.userId && dto.isActive === false) {
        throw new BadRequestException('Vous ne pouvez pas désactiver votre propre compte');
      }
      const { oldValues, newValues, changed } = diff(target, dto);
      if (!changed) return this.getTx(tx, id);
      await tx.user.update({ where: { id }, data: newValues });
      if (dto.isActive === false) {
        await tx.loginSession.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date(), revokedReason: 'USER_DEACTIVATED' },
        });
        await ensureAdministratorRemains(tx, me.companyId);
      }
      await this.audit.record(
        {
          action: dto.isActive === false ? 'USER_DEACTIVATED' : dto.isActive === true ? 'USER_REACTIVATED' : 'USER_UPDATED',
          entityType: 'User',
          entityId: id,
          establishmentId: null,
          oldValues,
          newValues,
        },
        tx,
      );
      return this.getTx(tx, id);
    });
  }

  async setRoles(me: AuthUser, id: string, dto: SetRolesDto) {
    if (id === me.userId) throw new ForbiddenException('Vous ne pouvez pas modifier vos propres rôles');
    const next = this.normalize(dto.roles);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${id}::uuid FOR UPDATE`;
      const target = await this.assertCanManage(me, id, tx);
      const current: Assignment[] = target.userRoles.map((r) => ({ roleId: r.roleId, establishmentId: r.establishmentId }));
      const added = next.filter((a) => !current.some((c) => key(c) === key(a)));
      const removed = current.filter((c) => !next.some((a) => key(a) === key(c)));
      await this.assertCanAssign(me, [...added, ...removed], tx);

      for (const r of removed) {
        await tx.userRole.deleteMany({ where: { userId: id, roleId: r.roleId, establishmentId: r.establishmentId } });
      }
      if (added.length) await tx.userRole.createMany({ data: added.map((a) => ({ ...a, userId: id })) });
      await ensureAdministratorRemains(tx, me.companyId);

      await this.audit.record(
        { action: 'USER_ROLES_CHANGED', entityType: 'User', entityId: id, establishmentId: null, oldValues: { roles: current }, newValues: { roles: next } },
        tx,
      );
      return this.getTx(tx, id);
    });
  }

  async resetPassword(me: AuthUser, id: string, dto: ResetPasswordDto) {
    assertPasswordPolicy(dto.password);
    const passwordHash = await hashPassword(dto.password);
    await this.prisma.$transaction(async (tx) => {
      await this.assertCanManage(me, id, tx);
      await tx.user.update({
        where: { id },
        data: { passwordHash, mustChangePassword: true, failedLoginCount: 0, lockedUntil: null, passwordChangedAt: new Date() },
      });
      await tx.loginSession.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'PASSWORD_RESET' },
      });
      await this.audit.record({ action: 'USER_PASSWORD_RESET', entityType: 'User', entityId: id, establishmentId: null }, tx);
    });
  }

  async unlock(me: AuthUser, id: string) {
    await this.prisma.$transaction(async (tx) => {
      await this.assertCanManage(me, id, tx);
      await tx.user.update({ where: { id }, data: { failedLoginCount: 0, lockedUntil: null } });
      await this.audit.record({ action: 'USER_UNLOCKED', entityType: 'User', entityId: id, establishmentId: null }, tx);
    });
  }

  private getTx(tx: Tx, id: string) {
    return tx.user.findUniqueOrThrow({ where: { id }, select: userSelect });
  }
}

@ApiTags('Utilisateurs')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly service: UsersService) {}

  @Get()
  @RequirePermissions('users.view')
  @AnyEstablishmentScope()
  list(@CurrentUser() me: AuthUser) {
    return this.service.list(me);
  }

  @Get(':id')
  @RequirePermissions('users.view')
  @AnyEstablishmentScope()
  get(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(me, id);
  }

  @Post()
  @RequirePermissions('users.manage')
  @AnyEstablishmentScope()
  create(@CurrentUser() me: AuthUser, @Body() dto: CreateUserDto) {
    return this.service.create(me, dto);
  }

  @Patch(':id')
  @RequirePermissions('users.manage')
  @AnyEstablishmentScope()
  update(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto) {
    return this.service.update(me, id, dto);
  }

  @Put(':id/roles')
  @RequirePermissions('users.manage')
  @AnyEstablishmentScope()
  setRoles(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetRolesDto) {
    return this.service.setRoles(me, id, dto);
  }

  @Post(':id/reset-password')
  @HttpCode(204)
  @RequirePermissions('users.manage')
  @AnyEstablishmentScope()
  resetPassword(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ResetPasswordDto) {
    return this.service.resetPassword(me, id, dto);
  }

  @Post(':id/unlock')
  @HttpCode(204)
  @RequirePermissions('users.manage')
  @AnyEstablishmentScope()
  unlock(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.unlock(me, id);
  }
}
