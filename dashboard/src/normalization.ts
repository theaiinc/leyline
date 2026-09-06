export type RuntimeConfig = {
  baseUrl?: string;
  model?: string;
  baseUrlConfigured?: boolean;
  openAICompatible?: boolean;
};

export type PersistenceMode = 'keychain' | 'localStorage' | 'memory' | 'arcana';
export type ApiKeySource = PersistenceMode | 'arcana' | 'env' | 'none';

export type ApiKeyProvider = {
  name: string;
  family?: string;
  label?: string;
  defaultModel: string;
  configured: boolean;
  source: ApiKeySource;
  persisted: boolean;
  arcanaAvailable?: boolean;
  arcanaReference?: string;
  keychainAvailable: boolean;
  runtimeConfigurable: boolean;
  runtimeConfig?: RuntimeConfig;
  runtimeReady?: boolean;
};

export type RoutingStatus = {
  singleModelEnabled: boolean;
  fixedProvider: string | null;
  fixedModel: string | null;
  /** Provider name → model ids enabled for auto routing. Empty = all models. */
  enabledModels: Record<string, string[]>;
  /** Model id → preferred provider name, used to disambiguate duplicate model ids across instances. */
  modelPins: Record<string, string>;
  /** Model id → provider names that list it. */
  modelIndex: Record<string, string[]>;
};

export type InstanceFieldSpec = {
  key: string;
  label: string;
  role: 'secret' | 'runtimeBaseUrl' | 'runtimeModel' | 'extra';
  required?: boolean;
  placeholder?: string;
};

export type InstanceFamily = {
  family: string;
  displayName: string;
  baseName: string;
  fields: InstanceFieldSpec[];
  instances: Array<{ id: string; name: string; label?: string }>;
};

export type ProviderInstancesResponse = {
  families: InstanceFamily[];
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
  family?: string;
  label?: string;
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
  clientAuth?: ClientAuthInfo;
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

export type ClientAuthInfo = {
  enabled: boolean;
  apiKey?: string;
  generated: boolean;
};

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger';

const UNKNOWN_PROVIDER = 'Unknown provider';
const PROVIDER_TONES = new Set(['gemini', 'huggingface', 'openai', 'openrouter', 'azureopenai', 'ollama', 'llmapi']);

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
  if (value === 'env' || value === 'arcana' || value === 'keychain' || value === 'localStorage' || value === 'memory') {
    return value;
  }

  return 'none';
}

function persistenceModeValue(value: unknown, fallback: PersistenceMode): PersistenceMode {
  if (value === 'keychain' || value === 'localStorage' || value === 'memory' || value === 'arcana') {
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
      arcana: normalizePersistenceMode(modes.arcana),
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

export function normalizeEnabledModels(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) return {};
  const result: Record<string, string[]> = {};
  for (const [provider, models] of Object.entries(value)) {
    if (!Array.isArray(models)) continue;
    result[provider] = models.filter((model): model is string => typeof model === 'string');
  }
  return result;
}

export function normalizeModelPins(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [model, provider] of Object.entries(value)) {
    if (typeof provider === 'string' && provider) result[model] = provider;
  }
  return result;
}

export function normalizeModelIndex(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) return {};
  const result: Record<string, string[]> = {};
  for (const [model, providers] of Object.entries(value)) {
    if (!Array.isArray(providers)) continue;
    result[model] = providers.filter((provider): provider is string => typeof provider === 'string');
  }
  return result;
}

export function normalizeRouting(value: unknown): RoutingStatus | undefined {
  if (!isRecord(value)) return undefined;

  return {
    singleModelEnabled: Boolean(value.singleModelEnabled),
    fixedProvider: optionalString(value.fixedProvider) || null,
    fixedModel: optionalString(value.fixedModel) || null,
    enabledModels: normalizeEnabledModels(value.enabledModels),
    modelPins: normalizeModelPins(value.modelPins),
    modelIndex: normalizeModelIndex(value.modelIndex),
  };
}

function normalizeInstanceField(value: unknown): InstanceFieldSpec | undefined {
  if (!isRecord(value)) return undefined;
  const key = optionalString(value.key);
  const label = optionalString(value.label);
  const role = value.role;
  if (!key || !label || (role !== 'secret' && role !== 'runtimeBaseUrl' && role !== 'runtimeModel' && role !== 'extra')) {
    return undefined;
  }
  return {
    key,
    label,
    role,
    required: Boolean(value.required),
    placeholder: optionalString(value.placeholder),
  };
}

function normalizeInstanceFamily(value: unknown): InstanceFamily | undefined {
  if (!isRecord(value)) return undefined;
  const family = optionalString(value.family);
  const baseName = optionalString(value.baseName);
  if (!family || !baseName) return undefined;

  return {
    family,
    displayName: optionalString(value.displayName) || family,
    baseName,
    fields: Array.isArray(value.fields)
      ? value.fields.map(normalizeInstanceField).filter((field): field is InstanceFieldSpec => Boolean(field))
      : [],
    instances: Array.isArray(value.instances)
      ? value.instances
        .filter(isRecord)
        .map(instance => ({
          id: asString(instance.id),
          name: asString(instance.name),
          label: optionalString(instance.label),
        }))
        .filter(instance => instance.id && instance.name)
      : [],
  };
}

export function normalizeProviderInstancesResponse(value: unknown): ProviderInstancesResponse {
  const raw = isRecord(value) ? value : {};
  return {
    families: Array.isArray(raw.families)
      ? raw.families.map(normalizeInstanceFamily).filter((family): family is InstanceFamily => Boolean(family))
      : [],
  };
}

function normalizeApiKeyProvider(value: unknown, index: number): ApiKeyProvider {
  const raw = isRecord(value) ? value : {};

  return {
    name: providerName(raw.name, index),
    family: optionalString(raw.family),
    label: optionalString(raw.label),
    defaultModel: optionalString(raw.defaultModel) || '-',
    configured: Boolean(raw.configured),
    source: sourceValue(raw.source),
    persisted: Boolean(raw.persisted),
    arcanaAvailable: Boolean(raw.arcanaAvailable),
    arcanaReference: optionalString(raw.arcanaReference),
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
    family: optionalString(raw.family),
    label: optionalString(raw.label),
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

function normalizeClientAuth(value: unknown): ClientAuthInfo | undefined {
  if (!isRecord(value)) return undefined;

  return {
    enabled: Boolean(value.enabled),
    apiKey: optionalString(value.apiKey),
    generated: Boolean(value.generated),
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

/** Groups a provider's name under its family, falling back to the name itself for single-instance providers. */
export function familyOf(name: unknown, family?: unknown): string {
  return optionalString(family) || asString(name);
}

export function providerTone(provider: unknown, family?: unknown): string {
  const tone = familyOf(provider, family).toLowerCase().replace(/[^a-z0-9]/g, '');
  return PROVIDER_TONES.has(tone) ? tone : 'default';
}

export function sourceLabel(source: unknown): string {
  if (source === 'env') return '.env';
  if (source === 'arcana') return 'Arcana';
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
  if (usage.chars !== undefined) return `${usage.chars} output chars`;
  return '-';
}

export function providerDescription(name: string, family?: string): string | undefined {
  if (name === 'OpenAI') return 'Direct OpenAI API (api.openai.com). Not Azure.';
  if (name === 'LLM API') return 'OpenAI-compatible LLM API — configure its endpoint and credential independently.';
  if (familyOf(name, family) === 'AzureOpenAI') return 'Azure OpenAI — save your Azure resource key and base URL here.';
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
    clientAuth: normalizeClientAuth(raw.clientAuth),
  };
}
