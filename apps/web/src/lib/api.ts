// Client HTTP de l'API AFRIKA FOOD.
// - jeton d'accès gardé en mémoire uniquement (jamais dans localStorage) ;
// - renouvellement automatique via le cookie httpOnly sur réponse 401 ;
// - en-tête X-Establishment-Id ajouté selon l'établissement sélectionné.

let accessToken: string | null = null;
let establishmentId: string | null = null;
let refreshing: Promise<boolean> | null = null;
let onSessionLost: (() => void) | null = null;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export const session = {
  setToken(token: string | null) {
    accessToken = token;
  },
  setEstablishment(id: string | null) {
    establishmentId = id;
  },
  onLost(fn: () => void) {
    onSessionLost = fn;
  },
};

/** Un seul renouvellement à la fois, même si plusieurs requêtes échouent ensemble. */
export function refreshAccessToken(): Promise<boolean> {
  refreshing ??= fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' })
    .then(async (res) => {
      if (!res.ok) return false;
      accessToken = (await res.json()).accessToken;
      return true;
    })
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

function messageOf(body: unknown, status: number): string {
  if (body && typeof body === 'object' && 'message' in body) {
    const m = (body as { message: unknown }).message;
    if (Array.isArray(m)) return m.join(' · ');
    if (typeof m === 'string') return m;
  }
  if (status === 0) return 'Serveur injoignable. Vérifiez la connexion réseau.';
  return `Erreur ${status}`;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Ignore l'établissement sélectionné (requête de niveau groupe). */
  noEstablishment?: boolean;
}

export async function apiFetch<T = unknown>(path: string, opts: RequestOptions = {}, retry = true): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (establishmentId && !opts.noEstablishment) headers['X-Establishment-Id'] = establishmentId;

  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, messageOf(null, 0));
  }

  if (res.status === 401 && retry && !path.startsWith('/auth/login')) {
    if (await refreshAccessToken()) return apiFetch<T>(path, opts, false);
    onSessionLost?.();
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const code = body && typeof body === 'object' && 'code' in body ? String(body.code) : undefined;
    throw new ApiError(res.status, messageOf(body, res.status), code, body);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string, opts?: Omit<RequestOptions, 'method' | 'body'>) => apiFetch<T>(path, { ...opts, method: 'GET' }),
  post: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'method' | 'body'>) => apiFetch<T>(path, { ...opts, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'method' | 'body'>) => apiFetch<T>(path, { ...opts, method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'method' | 'body'>) => apiFetch<T>(path, { ...opts, method: 'PUT', body }),
  delete: <T>(path: string, opts?: Omit<RequestOptions, 'method' | 'body'>) => apiFetch<T>(path, { ...opts, method: 'DELETE' }),
};
