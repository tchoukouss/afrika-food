import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// Droits effectifs d'un utilisateur.
// - global : permissions issues de rôles sans établissement (valables partout) ;
// - byEstablishment : permissions issues de rôles attribués sur un établissement.
export class UserAccess {
  constructor(
    readonly global: Set<string>,
    readonly byEstablishment: Map<string, Set<string>>,
    /** Établissements actifs de l'entreprise auxquels l'utilisateur a accès. */
    readonly establishmentIds: string[],
  ) {}

  /** Permissions effectives dans un établissement (ou au niveau groupe si null). */
  permissionsIn(establishmentId: string | null | undefined): Set<string> {
    if (!establishmentId) return this.global;
    const local = this.byEstablishment.get(establishmentId);
    if (!local) return this.global;
    return new Set([...this.global, ...local]);
  }

  can(permission: string, establishmentId?: string | null): boolean {
    return this.permissionsIn(establishmentId).has(permission);
  }

  canAccessEstablishment(establishmentId: string): boolean {
    return this.establishmentIds.includes(establishmentId);
  }

  /** Établissements où l'utilisateur dispose d'une permission donnée. */
  establishmentsWith(permission: string): string[] {
    return this.establishmentIds.filter((id) => this.can(permission, id));
  }
}

@Injectable()
export class AccessService {
  constructor(private readonly prisma: PrismaService) {}

  async load(userId: string, companyId: string): Promise<UserAccess> {
    const [assignments, establishments] = await Promise.all([
      this.prisma.userRole.findMany({
        where: { userId, role: { deletedAt: null, companyId } },
        select: {
          establishmentId: true,
          role: { select: { permissions: { select: { permissionCode: true } } } },
        },
      }),
      this.prisma.establishment.findMany({
        where: { companyId, deletedAt: null, isActive: true },
        select: { id: true },
      }),
    ]);

    const global = new Set<string>();
    const byEstablishment = new Map<string, Set<string>>();
    for (const a of assignments) {
      const codes = a.role.permissions.map((p) => p.permissionCode);
      if (a.establishmentId === null) {
        codes.forEach((c) => global.add(c));
      } else {
        const set = byEstablishment.get(a.establishmentId) ?? new Set<string>();
        codes.forEach((c) => set.add(c));
        byEstablishment.set(a.establishmentId, set);
      }
    }

    const activeIds = establishments.map((e) => e.id);
    // Un rôle global donne accès à tous les établissements actifs ;
    // sinon seulement à ceux où un rôle a été attribué.
    const accessible = global.size > 0 ? activeIds : activeIds.filter((id) => byEstablishment.has(id));
    return new UserAccess(global, byEstablishment, accessible);
  }
}
