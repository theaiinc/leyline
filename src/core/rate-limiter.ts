const ONE_MINUTE_MS = 60_000;

export interface ProviderRateLimit {
  /** Maximum admitted requests in any rolling minute. Omit for no RPM cap. */
  requestsPerMinute?: number;
  /** Maximum admitted/recorded tokens in any rolling minute. Omit for no TPM cap. */
  tokensPerMinute?: number;
  /** Set false to keep the config present but bypass scheduling. */
  enabled?: boolean;
}

export interface RateLimitRequest {
  /** Conservative prompt + expected completion token estimate for the request. */
  estimatedTokens?: number;
}

export interface RateLimitDelayReason {
  limit: 'requestsPerMinute' | 'tokensPerMinute';
  current: number;
  requested: number;
  maximum: number;
  waitMs: number;
}

export interface RateLimitDelayEvent {
  providerName: string;
  estimatedTokens: number;
  delayMs: number;
  reasons: RateLimitDelayReason[];
}

export interface RateLimitLease {
  providerName: string;
  estimatedTokens: number;
  admittedAt: number;
  /**
   * Replace the estimate with provider-reported total tokens after the request
   * completes. Future scheduling uses the corrected usage.
   */
  updateTokenUsage(actualTokens: number): void;
}

export interface RateLimiterClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export type RateLimitLogger = (event: RateLimitDelayEvent) => void;

interface RequestEvent {
  timestamp: number;
}

interface TokenEvent {
  timestamp: number;
  tokens: number;
}

interface ProviderState {
  requests: RequestEvent[];
  tokens: TokenEvent[];
  queue: Promise<void>;
}

export class RateLimitExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitExceededError';
  }
}

const systemClock: RateLimiterClock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
};

function defaultLogger(event: RateLimitDelayEvent) {
  const reasons = event.reasons
    .map(reason => `${reason.limit}=${reason.current}+${reason.requested}/${reason.maximum}`)
    .join(', ');
  console.warn(`[RateLimiter] Delaying ${event.providerName} request for ${event.delayMs}ms to respect ${reasons}`);
}

function positiveLimit(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function tokenCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 0;
  return Math.ceil(value);
}

export class ProviderRateLimiter {
  private readonly limits = new Map<string, ProviderRateLimit>();
  private readonly states = new Map<string, ProviderState>();
  private readonly clock: RateLimiterClock;
  private readonly logDelay: RateLimitLogger;

  constructor(options: { clock?: RateLimiterClock; logDelay?: RateLimitLogger } = {}) {
    this.clock = options.clock ?? systemClock;
    this.logDelay = options.logDelay ?? defaultLogger;
  }

  setLimit(providerName: string, limit: ProviderRateLimit) {
    this.limits.set(providerName, { ...limit });
  }

  getLimit(providerName: string): ProviderRateLimit | undefined {
    const limit = this.limits.get(providerName);
    return limit ? { ...limit } : undefined;
  }

  async acquire(providerName: string, request: RateLimitRequest = {}): Promise<RateLimitLease> {
    const state = this.getState(providerName);
    const run = state.queue.then(
      () => this.acquireAfterQueue(providerName, request),
      () => this.acquireAfterQueue(providerName, request),
    );
    state.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async acquireAfterQueue(providerName: string, request: RateLimitRequest): Promise<RateLimitLease> {
    const state = this.getState(providerName);
    const estimatedTokens = tokenCount(request.estimatedTokens);

    while (true) {
      const activeLimit = this.activeLimit(providerName);
      if (!activeLimit) {
        return this.createLease(providerName, estimatedTokens, this.clock.now());
      }

      if (activeLimit.tokensPerMinute && estimatedTokens > activeLimit.tokensPerMinute) {
        throw new RateLimitExceededError(
          `${providerName} request estimates ${estimatedTokens} tokens, above tokensPerMinute limit ${activeLimit.tokensPerMinute}.`,
        );
      }

      const now = this.clock.now();
      this.prune(state, now);
      const reasons = this.delayReasons(
        state,
        estimatedTokens,
        activeLimit.requestsPerMinute,
        activeLimit.tokensPerMinute,
        now,
      );

      if (reasons.length === 0) {
        const admittedAt = this.clock.now();
        state.requests.push({ timestamp: admittedAt });
        const tokenEvent: TokenEvent = { timestamp: admittedAt, tokens: estimatedTokens };
        state.tokens.push(tokenEvent);
        return this.createLease(providerName, estimatedTokens, admittedAt, tokenEvent);
      }

      const delayMs = Math.max(...reasons.map(reason => reason.waitMs));
      this.emitDelay({ providerName, estimatedTokens, delayMs, reasons });
      await this.clock.sleep(delayMs);
    }
  }

  private activeLimit(providerName: string): { requestsPerMinute?: number; tokensPerMinute?: number } | null {
    const limit = this.limits.get(providerName);
    const requestsPerMinute = positiveLimit(limit?.requestsPerMinute);
    const tokensPerMinute = positiveLimit(limit?.tokensPerMinute);

    if (!limit || limit.enabled === false || (!requestsPerMinute && !tokensPerMinute)) {
      return null;
    }

    return { requestsPerMinute, tokensPerMinute };
  }

  private emitDelay(event: RateLimitDelayEvent) {
    try {
      this.logDelay(event);
    } catch (error: any) {
      console.warn(`[RateLimiter] Delay logger failed for ${event.providerName}: ${error?.message || error}`);
    }
  }

  private delayReasons(
    state: ProviderState,
    estimatedTokens: number,
    requestsPerMinute: number | undefined,
    tokensPerMinute: number | undefined,
    now: number,
  ): RateLimitDelayReason[] {
    const reasons: RateLimitDelayReason[] = [];

    if (requestsPerMinute && state.requests.length + 1 > requestsPerMinute) {
      reasons.push({
        limit: 'requestsPerMinute',
        current: state.requests.length,
        requested: 1,
        maximum: requestsPerMinute,
        waitMs: this.waitUntil(state.requests[0].timestamp, now),
      });
    }

    if (tokensPerMinute) {
      const currentTokens = state.tokens.reduce((sum, event) => sum + event.tokens, 0);
      const excess = currentTokens + estimatedTokens - tokensPerMinute;
      if (excess > 0) {
        let released = 0;
        let releaseTimestamp = state.tokens[0]?.timestamp ?? now;
        for (const event of state.tokens) {
          released += event.tokens;
          releaseTimestamp = event.timestamp;
          if (released >= excess) break;
        }
        reasons.push({
          limit: 'tokensPerMinute',
          current: currentTokens,
          requested: estimatedTokens,
          maximum: tokensPerMinute,
          waitMs: this.waitUntil(releaseTimestamp, now),
        });
      }
    }

    return reasons;
  }

  private waitUntil(eventTimestamp: number, now: number): number {
    return Math.max(1, eventTimestamp + ONE_MINUTE_MS - now);
  }

  private prune(state: ProviderState, now: number) {
    const cutoff = now - ONE_MINUTE_MS;
    state.requests = state.requests.filter(event => event.timestamp > cutoff);
    state.tokens = state.tokens.filter(event => event.timestamp > cutoff);
  }

  private createLease(
    providerName: string,
    estimatedTokens: number,
    admittedAt: number,
    tokenEvent?: TokenEvent,
  ): RateLimitLease {
    return {
      providerName,
      estimatedTokens,
      admittedAt,
      updateTokenUsage(actualTokens: number) {
        if (tokenEvent) {
          tokenEvent.tokens = tokenCount(actualTokens);
        }
      },
    };
  }

  private getState(providerName: string): ProviderState {
    let state = this.states.get(providerName);
    if (!state) {
      state = { requests: [], tokens: [], queue: Promise.resolve() };
      this.states.set(providerName, state);
    }
    return state;
  }
}
