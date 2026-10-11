const API_BASE = (import.meta.env.VITE_LEYLINE_API_BASE_URL || window.location.origin).replace(/\/$/, '');

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

/** JSON request to Leyline; throws an Error with the server's message when it isn't OK. */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const response = await fetch(apiUrl(path), {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: { ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = (data as { error?: unknown }).error;
    const message = typeof error === 'string' ? error : (error as { message?: string } | undefined)?.message;
    throw new Error(message || `Request failed (${response.status})`);
  }
  return data as T;
}

/** Who is looking: the local desktop/dashboard, or hosted Leyline with its signed-in owner. */
export type Session = { hosted: boolean; email?: string | null; publicUrl?: string; signIn?: boolean };

export async function fetchSession(): Promise<Session> {
  try {
    return await api<Session>('/dashboard/session');
  } catch {
    return { hosted: false };
  }
}

export type KeyCaps = {
  tokensPerMonth?: number | null;
  requestsPerDay?: number | null;
  requestsPerMinute?: number | null;
  usdPerMonth?: number | null;
  models?: string[] | null;
};

export type IssuedKey = {
  id: string;
  name: string;
  prefix: string;
  caps: KeyCaps;
  note?: string;
  createdAt: number;
  createdBy: string;
  revokedAt?: number | null;
  lastUsedAt?: number | null;
  usage?: {
    month: string;
    requests: number;
    promptTokens: number;
    completionTokens: number;
    usd?: number;
    byModel: Record<string, { requests: number; tokens: number; usd?: number }>;
  };
};

export type Price = { input: number; output: number };

export type HostedSettings = {
  models: string[];
  aliases: Record<string, string>;
  monthlyBudgetUsd: number | null;
  prices: Record<string, Price>;
  defaultPrice: Price;
  spend: { month: string; usd: number; requests: number };
  saved: { at: number; by: string } | null;
  publicUrl: string;
};
