import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api, fetchSession, type Session } from '@/api';
import {
  type ApiKeyStatusResponse,
  type InstanceFamily,
  normalizeApiKeyStatusResponse,
  normalizeProviderInstancesResponse,
  normalizeRouting,
  normalizeStatsResponse,
  type StatsResponse,
} from '@/normalization';

const LOCAL_KEY_PREFIX = 'leyline.apiKey.';
const LOCAL_MODE_PREFIX = 'leyline.persistence.';
const LOCAL_RUNTIME_PREFIX = 'leyline.runtime.';
export const localKey = (provider: string) => `${LOCAL_KEY_PREFIX}${provider}`;
export const localModeKey = (provider: string) => `${LOCAL_MODE_PREFIX}${provider}`;
export const localRuntimeKey = (provider: string) => `${LOCAL_RUNTIME_PREFIX}${provider}`;

function storageAvailable(): boolean {
  try {
    window.localStorage.setItem('leyline.localStorage.test', '1');
    window.localStorage.removeItem('leyline.localStorage.test');
    return true;
  } catch {
    return false;
  }
}

/** Everything the dashboard shows, loaded from Leyline and refreshed every few seconds. */
export function useDashboard() {
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<ApiKeyStatusResponse | null>(null);
  const [stats, setStats] = useState<StatsResponse>({ providers: [], logs: [] });
  const [families, setFamilies] = useState<InstanceFamily[]>([]);
  const [waiting, setWaiting] = useState(false);
  const localStorageAvailable = useMemo(storageAvailable, []);

  const refreshStatus = useCallback(async () => {
    const normalized = normalizeApiKeyStatusResponse(await api('/dashboard/api-keys'));
    setStatus(normalized);
    return normalized;
  }, []);
  const refreshStats = useCallback(async () => {
    setStats(normalizeStatsResponse(await api('/dashboard/stats')));
  }, []);
  const refreshFamilies = useCallback(async () => {
    setFamilies(normalizeProviderInstancesResponse(await api('/dashboard/provider-instances')).families);
  }, []);
  const refreshAll = useCallback(async () => {
    await Promise.all([refreshStatus(), refreshStats(), refreshFamilies()]);
  }, [refreshStatus, refreshStats, refreshFamilies]);

  // Keys kept in this browser (localStorage mode) are re-sent to Leyline when the dashboard opens.
  async function rehydrate(data: ApiKeyStatusResponse) {
    if (!localStorageAvailable) return;
    await Promise.all(data.providers.map(async provider => {
      if (window.localStorage.getItem(localModeKey(provider.name)) === 'localStorage') {
        const apiKey = window.localStorage.getItem(localKey(provider.name));
        if (apiKey) await api('/dashboard/api-keys', { method: 'POST', body: { provider: provider.name, apiKey, persistence: 'localStorage' } });
      }
      if (provider.runtimeConfigurable) {
        const stored = window.localStorage.getItem(localRuntimeKey(provider.name));
        if (!stored) return;
        try {
          const { baseUrl, model } = JSON.parse(stored) as { baseUrl?: string; model?: string };
          await api('/dashboard/api-keys', { method: 'POST', body: { provider: provider.name, baseUrl, model } });
        } catch {
          // a malformed entry is ignored
        }
      }
    }));
  }

  useEffect(() => {
    let cancelled = false;
    let interval: number | undefined;
    (async () => {
      const who = await fetchSession();
      if (cancelled) return;
      setSession(who);
      let data: ApiKeyStatusResponse | undefined;
      while (!cancelled && !data) {
        try {
          data = await refreshStatus();
          setWaiting(false);
        } catch {
          setWaiting(true);
          await new Promise(resolve => window.setTimeout(resolve, 1000));
        }
      }
      if (cancelled || !data) return;
      if (!who.hosted) {
        try {
          await rehydrate(data);
          await refreshStatus();
        } catch (error) {
          toast.error(error instanceof Error ? error.message : 'Could not restore browser-stored keys');
        }
      }
      refreshStats().catch(() => undefined);
      refreshFamilies().catch(() => undefined);
      interval = window.setInterval(() => { refreshStats().catch(() => undefined); }, 5000);
    })();
    return () => {
      cancelled = true;
      if (interval) window.clearInterval(interval);
    };
  }, []);

  async function updateRouting(body: Record<string, unknown>, success?: string): Promise<boolean> {
    try {
      const routing = normalizeRouting(await api('/dashboard/routing', { method: 'POST', body }));
      setStatus(current => (current ? { ...current, routing } : current));
      if (success) toast.success(success);
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update routing');
      return false;
    }
  }

  return {
    session,
    status,
    stats,
    families,
    waiting,
    localStorageAvailable,
    storeLabel: status?.persistence.server.label || 'Apple Keychain',
    refreshStatus,
    refreshStats,
    refreshFamilies,
    refreshAll,
    updateRouting,
  };
}

export type Dashboard = ReturnType<typeof useDashboard>;
