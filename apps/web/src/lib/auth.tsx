import { useQueryClient } from '@tanstack/react-query';
import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, refreshAccessToken, session } from './api';
import type { Me } from './types';

const EST_KEY = 'af.establishment';

interface AuthState {
  me: Me | null;
  loading: boolean;
  /** Établissement de travail ; null = vue groupe (si autorisée). */
  establishmentId: string | null;
  setEstablishmentId: (id: string | null) => void;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
  /** Permission dans l'établissement courant (ou au niveau groupe). */
  can: (permission: string) => boolean;
  /** Permission détenue dans au moins un établissement ou au niveau groupe. */
  canAnywhere: (permission: string) => boolean;
  hasGroupAccess: boolean;
}

const AuthContext = createContext<AuthState | null>(null);

function readStoredEstablishment(): string | null {
  try {
    return localStorage.getItem(EST_KEY);
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [establishmentId, setEst] = useState<string | null>(null);

  const applyMe = useCallback((data: Me) => {
    setMe(data);
    const stored = readStoredEstablishment();
    const valid = data.establishments.find((e) => e.id === stored)?.id;
    // Sans accès groupe, on se place d'office sur le premier établissement autorisé.
    const fallback = data.globalPermissions.length > 0 ? null : data.establishments[0]?.id ?? null;
    const chosen = valid ?? fallback;
    session.setEstablishment(chosen);
    setEst(chosen);
  }, []);

  const reload = useCallback(async () => {
    applyMe(await api.get<Me>('/auth/me', { noEstablishment: true }));
  }, [applyMe]);

  // Au chargement : tentative de reprise de session via le cookie de rafraîchissement.
  useEffect(() => {
    session.onLost(() => {
      session.setToken(null);
      setMe(null);
      queryClient.clear();
    });
    (async () => {
      if (await refreshAccessToken()) {
        try {
          await reload();
        } catch {
          setMe(null);
        }
      }
      setLoading(false);
    })();
  }, [reload, queryClient]);

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await api.post<{ accessToken: string; user: Me }>('/auth/login', { email, password }, { noEstablishment: true });
      session.setToken(res.accessToken);
      applyMe(res.user);
    },
    [applyMe],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout', undefined, { noEstablishment: true });
    } finally {
      session.setToken(null);
      setMe(null);
      queryClient.clear();
    }
  }, [queryClient]);

  const setEstablishmentId = useCallback(
    (id: string | null) => {
      try {
        if (id) localStorage.setItem(EST_KEY, id);
        else localStorage.removeItem(EST_KEY);
      } catch {
        // stockage indisponible : le choix vaut pour la session en cours
      }
      session.setEstablishment(id);
      setEst(id);
      queryClient.invalidateQueries();
    },
    [queryClient],
  );

  const value = useMemo<AuthState>(() => {
    const global = new Set(me?.globalPermissions ?? []);
    const current = me?.establishments.find((e) => e.id === establishmentId);
    const effective = current ? new Set(current.permissions) : global;
    return {
      me,
      loading,
      establishmentId,
      setEstablishmentId,
      login,
      logout,
      reload,
      can: (p) => effective.has(p),
      canAnywhere: (p) => global.has(p) || !!me?.establishments.some((e) => e.permissions.includes(p)),
      hasGroupAccess: global.size > 0,
    };
  }, [me, loading, establishmentId, setEstablishmentId, login, logout, reload]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth hors AuthProvider');
  return ctx;
}
