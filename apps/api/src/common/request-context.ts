import { AsyncLocalStorage } from 'node:async_hooks';
import { UserAccess } from '../auth/access.service';

// Contexte de la requête HTTP en cours : qui agit, depuis où, sur quel
// établissement. Utilisé par le journal d'audit et les contrôles d'accès
// sans devoir passer ces informations à chaque fonction.
export interface RequestContext {
  ipAddress?: string;
  userAgent?: string;
  userId?: string;
  companyId?: string;
  sessionId?: string;
  establishmentId?: string;
  access?: UserAccess;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const requestContext = {
  run<T>(ctx: RequestContext, fn: () => T): T {
    return storage.run(ctx, fn);
  },
  get(): RequestContext {
    return storage.getStore() ?? {};
  },
};
