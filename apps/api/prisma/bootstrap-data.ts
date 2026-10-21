import { PrismaClient } from '@prisma/client';
import { DEFAULT_ROLES, PERMISSIONS } from '../src/auth/permissions.catalog';
import { hashPassword } from '../src/auth/password';

/**
 * Initialisation idempotente (peut être relancée sans risque) :
 * - synchronise le catalogue des permissions ;
 * - crée l'entreprise si elle n'existe pas ;
 * - crée les rôles par défaut manquants (le rôle Administrateur reçoit
 *   toujours la totalité des permissions, y compris les nouvelles) ;
 * - crée le premier administrateur si aucun utilisateur n'existe.
 */
export async function bootstrapData(
  prisma: PrismaClient,
  opts: { companyName: string; adminEmail: string; adminPassword: string; adminName: string },
) {
  for (const p of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { code: p.code },
      update: { module: p.module, label: p.label },
      create: p,
    });
  }

  let company = await prisma.company.findFirst({ where: { deletedAt: null }, orderBy: { createdAt: 'asc' } });
  if (!company) company = await prisma.company.create({ data: { name: opts.companyName, currency: 'XOF' } });

  for (const def of DEFAULT_ROLES) {
    const existing = await prisma.role.findUnique({ where: { companyId_code: { companyId: company.id, code: def.code } } });
    if (!existing) {
      await prisma.role.create({
        data: {
          companyId: company.id,
          code: def.code,
          name: def.name,
          description: def.description,
          isSystem: true,
          permissions: { create: def.permissions.map((permissionCode) => ({ permissionCode })) },
        },
      });
    } else if (def.code === 'ADMIN') {
      await prisma.rolePermission.createMany({
        data: def.permissions.map((permissionCode) => ({ roleId: existing.id, permissionCode })),
        skipDuplicates: true,
      });
    }
  }

  const userCount = await prisma.user.count({ where: { companyId: company.id } });
  let adminCreated = false;
  if (userCount === 0) {
    const adminRole = await prisma.role.findUniqueOrThrow({ where: { companyId_code: { companyId: company.id, code: 'ADMIN' } } });
    const admin = await prisma.user.create({
      data: {
        companyId: company.id,
        email: opts.adminEmail.trim().toLowerCase(),
        fullName: opts.adminName,
        passwordHash: await hashPassword(opts.adminPassword),
        mustChangePassword: true,
        userRoles: { create: { roleId: adminRole.id, establishmentId: null } },
      },
    });
    await prisma.auditLog.create({
      data: { companyId: company.id, userId: null, action: 'USER_CREATED', entityType: 'User', entityId: admin.id, reason: 'Initialisation du système', newValues: { email: admin.email } },
    });
    adminCreated = true;
  }
  return { company, adminCreated };
}
