import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Injectable,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayUnique, IsArray, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { AnyEstablishmentScope, AuthUser, CurrentUser, GroupScope, RequirePermissions } from '../auth/decorators';
import { ALL_PERMISSION_CODES, PERMISSIONS } from '../auth/permissions.catalog';
import { PrismaService, Tx } from '../prisma/prisma.service';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateRoleDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @Matches(/^[A-Z][A-Z0-9_]{1,39}$/, { message: 'Code : lettres majuscules, chiffres et _ (ex. CAISSIER_CHEF)' })
  code: string;

  @Transform(trim) @IsString() @MinLength(2) @MaxLength(80) name: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(255) description?: string;
  @IsArray() @ArrayUnique() @IsString({ each: true }) permissions: string[];
}

export class UpdateRoleDto {
  @IsOptional() @Transform(trim) @IsString() @MinLength(2) @MaxLength(80) name?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(255) description?: string;
  @IsOptional() @IsArray() @ArrayUnique() @IsString({ each: true }) permissions?: string[];
}

/**
 * Vérifie qu'il reste au moins un utilisateur actif disposant, au niveau groupe,
 * des permissions d'administration. Empêche de verrouiller tout le monde dehors.
 */
export async function ensureAdministratorRemains(tx: Tx, companyId: string) {
  const rows = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(DISTINCT u.id) AS n
    FROM users u
    JOIN user_roles ur ON ur.user_id = u.id AND ur.establishment_id IS NULL
    JOIN roles r ON r.id = ur.role_id AND r.deleted_at IS NULL
    JOIN role_permissions rp ON rp.role_id = r.id AND rp.permission_code = 'roles.manage'
    WHERE u.company_id = ${companyId}::uuid AND u.is_active AND u.deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM user_roles ur2
        JOIN role_permissions rp2 ON rp2.role_id = ur2.role_id AND rp2.permission_code = 'users.manage'
        JOIN roles r2 ON r2.id = ur2.role_id AND r2.deleted_at IS NULL
        WHERE ur2.user_id = u.id AND ur2.establishment_id IS NULL
      )`;
  if (Number(rows[0].n) === 0) {
    throw new ConflictException(
      "Opération refusée : il doit rester au moins un administrateur actif (gestion des rôles et des utilisateurs).",
    );
  }
}

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(companyId: string) {
    return this.prisma.role
      .findMany({
        where: { companyId, deletedAt: null },
        orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
        include: { permissions: { select: { permissionCode: true } }, _count: { select: { userRoles: true } } },
      })
      .then((roles) =>
        roles.map(({ permissions, _count, ...r }) => ({
          ...r,
          permissions: permissions.map((p) => p.permissionCode).sort(),
          assignmentCount: _count.userRoles,
        })),
      );
  }

  private checkPermissions(me: AuthUser, codes: string[]) {
    const unknown = codes.filter((c) => !ALL_PERMISSION_CODES.includes(c));
    if (unknown.length) throw new BadRequestException(`Permissions inconnues : ${unknown.join(', ')}`);
    // Pas d'escalade de privilèges : on ne donne que ce que l'on possède soi-même.
    const missing = codes.filter((c) => !me.access.global.has(c));
    if (missing.length) {
      throw new ForbiddenException(`Vous ne pouvez pas attribuer des permissions que vous n'avez pas : ${missing.join(', ')}`);
    }
  }

  async create(me: AuthUser, dto: CreateRoleDto) {
    this.checkPermissions(me, dto.permissions);
    return this.prisma.$transaction(async (tx) => {
      const role = await tx.role.create({
        data: {
          companyId: me.companyId,
          code: dto.code,
          name: dto.name,
          description: dto.description,
          permissions: { create: dto.permissions.map((permissionCode) => ({ permissionCode })) },
        },
      });
      await this.audit.record(
        { action: 'ROLE_CREATED', entityType: 'Role', entityId: role.id, establishmentId: null, newValues: { ...dto } },
        tx,
      );
      return role;
    });
  }

  async update(me: AuthUser, id: string, dto: UpdateRoleDto) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM roles WHERE id = ${id}::uuid FOR UPDATE`;
      const role = await tx.role.findFirst({
        where: { id, companyId: me.companyId, deletedAt: null },
        include: { permissions: true },
      });
      if (!role) throw new NotFoundException('Rôle introuvable');
      const before = role.permissions.map((p) => p.permissionCode).sort();

      if (dto.permissions) {
        // On peut retirer ou ajouter uniquement des permissions que l'on détient.
        const added = dto.permissions.filter((c) => !before.includes(c));
        const removed = before.filter((c) => !dto.permissions!.includes(c));
        this.checkPermissions(me, [...added, ...removed]);
        await tx.rolePermission.deleteMany({ where: { roleId: id } });
        await tx.rolePermission.createMany({ data: dto.permissions.map((permissionCode) => ({ roleId: id, permissionCode })) });
      }
      const updated = await tx.role.update({
        where: { id },
        data: { name: dto.name, description: dto.description },
      });
      if (dto.permissions) await ensureAdministratorRemains(tx, me.companyId);

      await this.audit.record(
        {
          action: dto.permissions ? 'ROLE_PERMISSIONS_CHANGED' : 'ROLE_UPDATED',
          entityType: 'Role',
          entityId: id,
          establishmentId: null,
          oldValues: { name: role.name, description: role.description, permissions: before },
          newValues: { name: updated.name, description: updated.description, permissions: dto.permissions?.slice().sort() ?? before },
        },
        tx,
      );
      return updated;
    });
  }

  async remove(me: AuthUser, id: string) {
    await this.prisma.$transaction(async (tx) => {
      const role = await tx.role.findFirst({
        where: { id, companyId: me.companyId, deletedAt: null },
        include: { _count: { select: { userRoles: true } } },
      });
      if (!role) throw new NotFoundException('Rôle introuvable');
      if (role.isSystem) throw new ConflictException('Un rôle système ne peut pas être supprimé');
      if (role._count.userRoles > 0) throw new ConflictException('Ce rôle est encore attribué à des utilisateurs');
      await tx.role.update({ where: { id }, data: { deletedAt: new Date() } });
      await this.audit.record({ action: 'ROLE_DELETED', entityType: 'Role', entityId: id, establishmentId: null, oldValues: { code: role.code, name: role.name } }, tx);
    });
  }
}

@ApiTags('Rôles et permissions')
@ApiBearerAuth()
@Controller()
export class RolesController {
  constructor(private readonly service: RolesService) {}

  @Get('permissions')
  @RequirePermissions('users.view')
  @AnyEstablishmentScope()
  permissions() {
    return PERMISSIONS;
  }

  @Get('roles')
  @RequirePermissions('users.view')
  @AnyEstablishmentScope()
  list(@CurrentUser() me: AuthUser) {
    return this.service.list(me.companyId);
  }

  @Post('roles')
  @RequirePermissions('roles.manage')
  @GroupScope()
  create(@CurrentUser() me: AuthUser, @Body() dto: CreateRoleDto) {
    return this.service.create(me, dto);
  }

  @Patch('roles/:id')
  @RequirePermissions('roles.manage')
  @GroupScope()
  update(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRoleDto) {
    return this.service.update(me, id, dto);
  }

  @Delete('roles/:id')
  @HttpCode(204)
  @RequirePermissions('roles.manage')
  @GroupScope()
  remove(@CurrentUser() me: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(me, id);
  }
}
