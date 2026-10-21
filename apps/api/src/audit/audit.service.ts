import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { requestContext } from '../common/request-context';
import { Db, PrismaService } from '../prisma/prisma.service';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  establishmentId?: string | null;
  oldValues?: unknown;
  newValues?: unknown;
  reason?: string | null;
  /** À fournir quand aucun utilisateur n'est encore dans le contexte (ex. connexion). */
  companyId?: string;
  userId?: string | null;
}

// Champs jamais écrits dans le journal.
const SECRET_FIELDS = new Set(['passwordHash', 'password', 'refreshTokenHash', 'currentPassword', 'newPassword']);

function sanitize(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  return JSON.parse(
    JSON.stringify(value, (key, v) => {
      if (SECRET_FIELDS.has(key)) return undefined;
      if (typeof v === 'bigint') return v.toString();
      return v;
    }),
  );
}

/** Ne garde que les champs modifiés, pour un journal lisible. */
export function diff<T extends Record<string, unknown>>(before: T, after: Partial<T>) {
  const oldValues: Record<string, unknown> = {};
  const newValues: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    const a = before[key];
    const b = after[key];
    const same = a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : JSON.stringify(a) === JSON.stringify(b);
    if (!same && b !== undefined) {
      oldValues[key] = a;
      newValues[key] = b;
    }
  }
  return { oldValues, newValues, changed: Object.keys(newValues).length > 0 };
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Écrit une entrée d'audit. Passer la transaction en cours (tx) pour que
   * l'entrée soit validée ou annulée avec l'opération qu'elle décrit.
   */
  async record(entry: AuditEntry, db: Db = this.prisma) {
    const ctx = requestContext.get();
    const companyId = entry.companyId ?? ctx.companyId;
    if (!companyId) throw new Error('Audit sans entreprise');
    await db.auditLog.create({
      data: {
        companyId,
        establishmentId: entry.establishmentId === undefined ? ctx.establishmentId ?? null : entry.establishmentId,
        userId: entry.userId === undefined ? ctx.userId ?? null : entry.userId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        oldValues: sanitize(entry.oldValues),
        newValues: sanitize(entry.newValues),
        reason: entry.reason ?? null,
        ipAddress: ctx.ipAddress ?? null,
        userAgent: ctx.userAgent ?? null,
        sessionId: ctx.sessionId ?? null,
      },
    });
  }

  async securityEvent(type: string, data: { userId?: string | null; email?: string; details?: unknown }) {
    const ctx = requestContext.get();
    await this.prisma.securityEvent.create({
      data: {
        type,
        userId: data.userId ?? null,
        email: data.email ?? null,
        ipAddress: ctx.ipAddress ?? null,
        userAgent: ctx.userAgent ?? null,
        details: sanitize(data.details),
      },
    });
  }
}
