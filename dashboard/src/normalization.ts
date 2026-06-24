export type RuntimeConfig = {
  baseUrl?: string;
  model?: string;
  baseUrlConfigured?: boolean;
  openAICompatible?: boolean;
};

export type PersistenceMode = 'keychain' | 'localStorage' | 'memory';
export type ApiKeySource = PersistenceMode | 'env' | 'none';

export type ApiKeyProvider = {
  name: string;
  defaultModel: string;
  configured: boolean;
  source: ApiKeySource;
  persisted: boolean;
  keychainAvailable: boolean;
  runtimeConfigurable: boolean;
  runtimeConfig?: RuntimeConfig;
  runtimeReady?: boolean;
};

export type RoutingStatus = {
  singleModelEnabled: boolean;
  fixedProvider: string | null;
  fixedModel: string | null;
};

export type PersistenceStatus = {
  server: {
    mode: 'keychain' | 'memory';
    available: boolean;
    service: string;
    warning?: string;
  };
  modes: Record<PersistenceMode, { available: boolean; warning?: string; service?: string }>;
};

export type ApiKeyStatusResponse = {
  persistence: PersistenceStatus;
  routing?: RoutingStatus;
  providers: ApiKeyProvider[];
};

export type ModelSummary = {
  id: string;
  name?: string;
  description?: string;
  score?: number;
};

export type ProviderStats = {
  name: string;
  defaultModel: string;
  apiKeyConfigurable?: boolean;
  apiKeyConfigured?: boolean;
  apiKeyStatus?: Pick<ApiKeyProvider, 'configured' | 'source' | 'persisted'>;
  runtimeConfigurable?: boolean;
  runtimeConfig?: RuntimeConfig;
  runtimeReady?: boolean;
  models: ModelSummary[];
  quota?: { requestsPerMinute: number; requestsPerDay: number };
  usage: { minute: number; day: number };
};

export type LogEntry = {
  timestamp: string;
  requestId?: string;
  provider: string;
  model?: string;
  status: string;
  duration?: number;
  error?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; chars?: number };
};

export type StatsResponse = {
  providers: ProviderStats[];
  logs: LogEntry[];
  tunnel?: TunnelInfo;
};

export type TunnelState = 'disabled' | 'starting' | 'ready' | 'error';

export type TunnelInfo = {
  enabled: boolean;
  state: TunnelState;
  publicUrl?: string;
  publicBaseUrl?: string;
  localUrl?: string;
  error?: string;
};

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger';

const UNKNOWN_PROVIDER = 'Unknown provider';
const PROVIDER_TONES = new Set(['gemini', 'huggingface', 'openai', 'openrouter', 'azureopenai', 'ollama']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function optionalString(value: unknown): string | undefined {
  const normalized = asString(value).trim();
  return normalized || undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sourceValue(value: unknown): ApiKeySource {
  if (value === 'env' || value === 'keychain' || value === 'localStorage' || value === 'memory') {
    return value;
  }

  return 'none';
}

function persistenceModeValue(value: unknown, fallback: PersistenceMode): PersistenceMode {
  if (value === 'keychain' || value === 'localStorage' || value === 'memory') {
    return value;
  }

  return fallback;
}

function providerName(value: unknown, index: number): string {
  return optionalString(value) || `${UNKNOWN_PROVIDER} ${index + 1}`;
}

function normalizeRuntimeConfig(value: unknown): RuntimeConfig | undefined {
  if (!isRecord(value)) return undefined;

  return {
    baseUrl: optionalString(value.baseUrl),
    model: optionalString(value.model),
    baseUrlConfigured: typeof value.baseUrlConfigured === 'boolean' ? value.baseUrlConfigured : undefined,
    openAICompatible: typeof value.openAICompatible === 'boolean' ? value.openAICompatible : undefined,
  };
}

function normalizePersistenceMode(value: unknown, defaultAvailable = false): { available: boolean; warning?: string; service?: string } {
  const raw = isRecord(value) ? value : {};

  return {
    available: raw.available === undefined ? defaultAvailable : Boolean(raw.available),
    warning: optionalString(raw.warning),
    service: optionalString(raw.service),
  };
}

function normalizePersistence(value: unknown): PersistenceStatus {
  const raw = isRecord(value) ? value : {};
  const server = isRecord(raw.server) ? raw.server : {};
  const modes = isRecord(raw.modes) ? raw.modes : {};
  const serverMode = server.mode === 'keychain' ? 'keychain' : 'memory';

  return {
    server: {
      mode: serverMode,
      available: server.available === undefined ? serverMode === 'memory' : Boolean(server.available),
      service: asString(server.service),
      warning: optionalString(server.warning),
    },
    modes: {
      keychain: normalizePersistenceMode(modes.keychain),
      localStorage: normalizePersistenceMode(modes.localStorage, true),
      memory: normalizePersistenceMode(modes.memory, true),
    },
  };
}

function normalizeModel(value: unknown, index: number): ModelSummary {
  const raw = isRecord(value) ? value : {};
  const id = optionalString(raw.id) || optionalString(raw.name) || `model-${index + 1}`;
  const name = optionalString(raw.name);

  return {
    id,
    name: name && name !== id ? name : undefined,
    description: optionalString(raw.description),
    score: optionalNumber(raw.score),
  };
}

function normalizeQuota(value: unknown): ProviderStats['quota'] {
  if (!isRecord(value)) return undefined;
  const requestsPerMinute = optionalNumber(value.requestsPerMinute);
  const requestsPerDay = optionalNumber(value.requestsPerDay);
  if (requestsPerMinute === undefined || requestsPerDay === undefined) return undefined;

  return { requestsPerMinute, requestsPerDay };
}

function normalizeUsage(value: unknown): ProviderStats['usage'] {
  const raw = isRecord(value) ? value : {};

  return {
    minute: optionalNumber(raw.minute) || 0,
    day: optionalNumber(raw.day) || 0,
  };
}

function normalizeRouting(value: unknown): RoutingStatus | undefined {
  if (!isRecord(value)) return undefined;

  return {
    singleModelEnabled: Boolean(value.singleModelEnabled),
    fixedProvider: optionalString(value.fixedProvider) || null,
    fixedModel: optionalString(value.fixedModel) || null,
  };
}

function normalizeApiKeyProvider(value: unknown, index: number): ApiKeyProvider {
  const raw = isRecord(value) ? value : {};

  return {
    name: providerName(raw.name, index),
    defaultModel: optionalString(raw.defaultModel) || '-',
    configured: Boolean(raw.configured),
    source: sourceValue(raw.source),
    persisted: Boolean(raw.persisted),
    keychainAvailable: Boolean(raw.keychainAvailable),
    runtimeConfigurable: Boolean(raw.runtimeConfigurable),
    runtimeConfig: normalizeRuntimeConfig(raw.runtimeConfig),
    runtimeReady: typeof raw.runtimeReady === 'boolean' ? raw.runtimeReady : undefined,
  };
}

function normalizeProviderStats(value: unknown, index: number): ProviderStats {
  const raw = isRecord(value) ? value : {};
  const apiKeyStatus = isRecord(raw.apiKeyStatus)
    ? {
      configured: Boolean(raw.apiKeyStatus.configured),
      source: sourceValue(raw.apiKeyStatus.source),
      persisted: Boolean(raw.apiKeyStatus.persisted),
    }
    : undefined;

  return {
    name: providerName(raw.name, index),
    defaultModel: optionalString(raw.defaultModel) || '-',
    apiKeyConfigurable: typeof raw.apiKeyConfigurable === 'boolean' ? raw.apiKeyConfigurable : undefined,
    apiKeyConfigured: typeof raw.apiKeyConfigured === 'boolean' ? raw.apiKeyConfigured : undefined,
    apiKeyStatus,
    runtimeConfig: normalizeRuntimeConfig(raw.runtimeConfig),
    runtimeReady: typeof raw.runtimeReady === 'boolean' ? raw.runtimeReady : undefined,
    models: Array.isArray(raw.models) ? raw.models.map(normalizeModel) : [],
    quota: normalizeQuota(raw.quota),
    usage: normalizeUsage(raw.usage),
  };
}

function normalizeTunnel(value: unknown): TunnelInfo | undefined {
  if (!isRecord(value)) return undefined;

  const state = optionalString(value.state);
  const normalizedState: TunnelState = state === 'starting' || state === 'ready' || state === 'error'
    ? state
    : 'disabled';

  return {
    enabled: Boolean(value.enabled),
    state: normalizedState,
    publicUrl: optionalString(value.publicUrl),
    publicBaseUrl: optionalString(value.publicBaseUrl),
    localUrl: optionalString(value.localUrl),
    error: optionalString(value.error),
  };
}

function normalizeLog(value: unknown): LogEntry {
  const raw = isRecord(value) ? value : {};
  const status = optionalString(raw.status)?.toLowerCase() || 'unknown';
  const usage = isRecord(raw.usage) ? {
    prompt_tokens: optionalNumber(raw.usage.prompt_tokens),
    completion_tokens: optionalNumber(raw.usage.completion_tokens),
    total_tokens: optionalNumber(raw.usage.total_tokens),
    chars: optionalNumber(raw.usage.chars),
  } : undefined;

  return {
    timestamp: optionalString(raw.timestamp) || '',
    requestId: optionalString(raw.requestId),
    provider: optionalString(raw.provider) || UNKNOWN_PROVIDER,
    model: optionalString(raw.model),
    status,
    duration: optionalNumber(raw.duration),
    error: optionalString(raw.error),
    usage,
  };
}

export function asString(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return fallback;
  return String(value);
}

export function providerTone(provider: unknown): string {
  const tone = asString(provider).toLowerCase().replace(/[^a-z0-9]/g, '');
  return PROVIDER_TONES.has(tone) ? tone : 'default';
}

export function sourceLabel(source: unknown): string {
  if (source === 'env') return '.env';
  if (source === 'keychain') return 'Apple Keychain';
  if (source === 'localStorage') return 'Browser localStorage';
  if (source === 'memory') return 'Server memory';
  return 'Not configured';
}

export function statusTone(status: unknown): BadgeTone {
  const normalized = asString(status).toLowerCase();
  if (normalized === 'success') return 'success';
  if (normalized === 'rate_limited') return 'warning';
  return 'danger';
}

export function formatLogTime(timestamp: string): string {
  const time = new Date(timestamp).getTime();
  if (!Number.isFinite(time)) return '-';
  return new Date(time).toLocaleTimeString();
}

export function formatLogUsage(usage: LogEntry['usage']): string {
  if (!usage) return '-';
  if (usage.total_tokens !== undefined) return `${usage.total_tokens} tokens`;
  if (usage.prompt_tokens !== undefined || usage.completion_tokens !== undefined) {
    return `${usage.prompt_tokens || 0}/${usage.completion_tokens || 0} tokens`;
  }
  if (usage.chars !== undefined) return `${usage.chars} chars`;
  return '-';
}

export function providerDescription(name: string): string | undefined {
  if (name === 'OpenAI') return 'Direct OpenAI API (api.openai.com). Not Azure.';
  if (name === 'AzureOpenAI') return 'Azure OpenAI — save your Azure resource key and base URL here.';
  return undefined;
}

export function providerStatusLabel(provider: Pick<ApiKeyProvider, 'configured' | 'runtimeConfigurable' | 'runtimeReady'>): { label: string; tone: BadgeTone } {
  if (provider.runtimeConfigurable) {
    if (!provider.configured) return { label: 'Missing key', tone: 'danger' };
    if (provider.runtimeReady === false) return { label: 'Needs base URL', tone: 'warning' };
    return { label: 'Ready', tone: 'success' };
  }

  return provider.configured
    ? { label: 'Key configured', tone: 'success' }
    : { label: 'Missing key', tone: 'danger' };
}

export function normalizeApiKeyStatusResponse(value: unknown): ApiKeyStatusResponse {
  const raw = isRecord(value) ? value : {};

  return {
    persistence: normalizePersistence(raw.persistence),
    routing: normalizeRouting(raw.routing),
    providers: Array.isArray(raw.providers) ? raw.providers.map(normalizeApiKeyProvider) : [],
  };
}

export function normalizeStatsResponse(value: unknown): StatsResponse {
  const raw = isRecord(value) ? value : {};

  return {
    providers: Array.isArray(raw.providers) ? raw.providers.map(normalizeProviderStats) : [],
    logs: Array.isArray(raw.logs) ? raw.logs.map(normalizeLog) : [],
    tunnel: normalizeTunnel(raw.tunnel),
  };
}
