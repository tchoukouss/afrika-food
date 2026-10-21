import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { requestContext } from '../common/request-context';

export const IS_PUBLIC = 'isPublic';
/** Route accessible sans authentification. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const REQUIRED_PERMISSIONS = 'requiredPermissions';
export const PERMISSION_SCOPE = 'permissionScope';

/**
 * Permissions requises (toutes) pour accéder à la route.
 * Le contrôle se fait dans l'établissement indiqué par l'en-tête
 * X-Establishment-Id, ou au niveau groupe en l'absence d'en-tête.
 */
export const RequirePermissions = (...permissions: string[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);

/**
 * Une permission dans au moins UN établissement suffit pour entrer ;
 * le service filtre ensuite les données selon les établissements autorisés.
 * Utile pour les listes consolidées (ex. utilisateurs, rapports multi-sites).
 */
export const AnyEstablishmentScope = () => SetMetadata(PERMISSION_SCOPE, 'any');

/** La permission doit être détenue au niveau groupe (rôle sans établissement). */
export const GroupScope = () => SetMetadata(PERMISSION_SCOPE, 'group');

/** Contexte de l'utilisateur connecté (id, entreprise, session, droits). */
export const CurrentUser = createParamDecorator((_data: unknown, _ctx: ExecutionContext) => {
  const ctx = requestContext.get();
  return {
    userId: ctx.userId!,
    companyId: ctx.companyId!,
    sessionId: ctx.sessionId!,
    establishmentId: ctx.establishmentId,
    access: ctx.access!,
  };
});

export interface AuthUser {
  userId: string;
  companyId: string;
  sessionId: string;
  establishmentId?: string;
  access: import('./access.service').UserAccess;
}
