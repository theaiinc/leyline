import {
  ProviderRateLimiter,
  RateLimitDelayEvent,
  RateLimiterClock,
  RateLimitExceededError,
} from '../src/core/rate-limiter';

class FakeClock implements RateLimiterClock {
  current = 0;
  sleeps: number[] = [];

  now(): number {
    return this.current;
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.current += ms;
  }
}

class ManualClock implements RateLimiterClock {
  current = 0;
  sleeps: Array<{ ms: number; resolve: () => void }> = [];

  now(): number {
    return this.current;
  }

  sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      this.sleeps.push({ ms, resolve });
    });
  }

  advance(ms: number) {
    this.current += ms;
    const sleepers = this.sleeps.splice(0);
    sleepers.forEach(sleeper => sleeper.resolve());
  }
}

describe('ProviderRateLimiter', () => {
  let clock: FakeClock;
  let delays: RateLimitDelayEvent[];
  let limiter: ProviderRateLimiter;

  beforeEach(() => {
    clock = new FakeClock();
    delays = [];
    limiter = new ProviderRateLimiter({
      clock,
      logDelay: event => delays.push(event),
    });
  });

  it('admits requests immediately when no provider limit is configured', async () => {
    const lease = await limiter.acquire('AzureOpenAI', { estimatedTokens: 100 });

    expect(lease.admittedAt).toBe(0);
    expect(clock.sleeps).toEqual([]);
    expect(delays).toEqual([]);
  });

  it('delays to keep requests within a rolling RPM limit', async () => {
    limiter.setLimit('AzureOpenAI', { requestsPerMinute: 1 });

    const first = await limiter.acquire('AzureOpenAI');
    const second = await limiter.acquire('AzureOpenAI');

    expect(first.admittedAt).toBe(0);
    expect(second.admittedAt).toBe(60_000);
    expect(clock.sleeps).toEqual([60_000]);
    expect(delays).toHaveLength(1);
    expect(delays[0]).toMatchObject({
      providerName: 'AzureOpenAI',
      delayMs: 60_000,
      reasons: [
        {
          limit: 'requestsPerMinute',
          current: 1,
          requested: 1,
          maximum: 1,
          waitMs: 60_000,
        },
      ],
    });
  });

  it('delays to keep estimated tokens within a rolling TPM limit', async () => {
    limiter.setLimit('AzureOpenAI', { tokensPerMinute: 100 });

    await limiter.acquire('AzureOpenAI', { estimatedTokens: 60 });
    const second = await limiter.acquire('AzureOpenAI', { estimatedTokens: 50 });

    expect(second.admittedAt).toBe(60_000);
    expect(clock.sleeps).toEqual([60_000]);
    expect(delays[0].reasons).toEqual([
      {
        limit: 'tokensPerMinute',
        current: 60,
        requested: 50,
        maximum: 100,
        waitMs: 60_000,
      },
    ]);
  });

  it('waits for the stricter constraint when both RPM and TPM are exceeded', async () => {
    limiter.setLimit('AzureOpenAI', {
      requestsPerMinute: 2,
      tokensPerMinute: 100,
    });

    await limiter.acquire('AzureOpenAI', { estimatedTokens: 70 });
    clock.current = 30_000;
    await limiter.acquire('AzureOpenAI', { estimatedTokens: 20 });
    const third = await limiter.acquire('AzureOpenAI', { estimatedTokens: 90 });

    expect(third.admittedAt).toBe(90_000);
    expect(clock.sleeps).toEqual([60_000]);
    expect(delays[0].delayMs).toBe(60_000);
    expect(delays[0].reasons).toEqual([
      {
        limit: 'requestsPerMinute',
        current: 2,
        requested: 1,
        maximum: 2,
        waitMs: 30_000,
      },
      {
        limit: 'tokensPerMinute',
        current: 90,
        requested: 90,
        maximum: 100,
        waitMs: 60_000,
      },
    ]);
  });

  it('continues delaying when the delay logger throws', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const loggerFailureClock = new FakeClock();
    const loggerFailureLimiter = new ProviderRateLimiter({
      clock: loggerFailureClock,
      logDelay: () => {
        throw new Error('logger unavailable');
      },
    });
    loggerFailureLimiter.setLimit('AzureOpenAI', { requestsPerMinute: 1 });

    await loggerFailureLimiter.acquire('AzureOpenAI');
    const second = await loggerFailureLimiter.acquire('AzureOpenAI');

    expect(second.admittedAt).toBe(60_000);
    expect(loggerFailureClock.sleeps).toEqual([60_000]);
    expect(warnSpy).toHaveBeenCalledWith('[RateLimiter] Delay logger failed for AzureOpenAI: logger unavailable');
    warnSpy.mockRestore();
  });

  it('uses corrected provider token usage for future scheduling', async () => {
    limiter.setLimit('AzureOpenAI', { tokensPerMinute: 100 });

    const first = await limiter.acquire('AzureOpenAI', { estimatedTokens: 20 });
    first.updateTokenUsage(80);
    const second = await limiter.acquire('AzureOpenAI', { estimatedTokens: 30 });

    expect(second.admittedAt).toBe(60_000);
    expect(delays[0].reasons[0]).toMatchObject({
      limit: 'tokensPerMinute',
      current: 80,
      requested: 30,
      maximum: 100,
    });
  });

  it('serializes concurrent acquires for the same provider', async () => {
    limiter.setLimit('AzureOpenAI', { requestsPerMinute: 1 });

    const [first, second, third] = await Promise.all([
      limiter.acquire('AzureOpenAI'),
      limiter.acquire('AzureOpenAI'),
      limiter.acquire('AzureOpenAI'),
    ]);

    expect(first.admittedAt).toBe(0);
    expect(second.admittedAt).toBe(60_000);
    expect(third.admittedAt).toBe(120_000);
    expect(clock.sleeps).toEqual([60_000, 60_000]);
  });

  it('serializes concurrent token-limited acquires for the same provider', async () => {
    limiter.setLimit('AzureOpenAI', { tokensPerMinute: 100 });

    const [first, second, third] = await Promise.all([
      limiter.acquire('AzureOpenAI', { estimatedTokens: 60 }),
      limiter.acquire('AzureOpenAI', { estimatedTokens: 50 }),
      limiter.acquire('AzureOpenAI', { estimatedTokens: 40 }),
    ]);

    expect(first.admittedAt).toBe(0);
    expect(second.admittedAt).toBe(60_000);
    expect(third.admittedAt).toBe(60_000);
    expect(clock.sleeps).toEqual([60_000]);
    expect(delays).toHaveLength(1);
    expect(delays[0].reasons[0]).toMatchObject({
      limit: 'tokensPerMinute',
      current: 60,
      requested: 50,
      maximum: 100,
    });
  });

  it('does not let a rejected acquire poison later queued acquires', async () => {
    limiter.setLimit('AzureOpenAI', { tokensPerMinute: 100 });

    const rejected = limiter.acquire('AzureOpenAI', { estimatedTokens: 101 });
    const accepted = limiter.acquire('AzureOpenAI', { estimatedTokens: 50 });

    await expect(rejected).rejects.toThrow(RateLimitExceededError);
    await expect(accepted).resolves.toMatchObject({
      providerName: 'AzureOpenAI',
      admittedAt: 0,
      estimatedTokens: 50,
    });
    expect(clock.sleeps).toEqual([]);
  });

  it('does not block other providers while one provider queue is sleeping', async () => {
    const manualClock = new ManualClock();
    const manualDelays: RateLimitDelayEvent[] = [];
    const manualLimiter = new ProviderRateLimiter({
      clock: manualClock,
      logDelay: event => manualDelays.push(event),
    });
    manualLimiter.setLimit('AzureOpenAI', { requestsPerMinute: 1 });
    manualLimiter.setLimit('OpenAI', { requestsPerMinute: 1 });

    await manualLimiter.acquire('AzureOpenAI');
    const delayedAzure = manualLimiter.acquire('AzureOpenAI');
    await Promise.resolve();

    expect(manualClock.sleeps.map(sleep => sleep.ms)).toEqual([60_000]);
    expect(manualDelays.map(delay => delay.providerName)).toEqual(['AzureOpenAI']);

    const openAiLease = await manualLimiter.acquire('OpenAI');
    expect(openAiLease.admittedAt).toBe(0);

    let azureResolved = false;
    delayedAzure.then(() => {
      azureResolved = true;
    });
    await Promise.resolve();
    expect(azureResolved).toBe(false);

    manualClock.advance(60_000);
    const azureLease = await delayedAzure;
    expect(azureLease.admittedAt).toBe(60_000);
  });

  it('tracks providers independently', async () => {
    limiter.setLimit('AzureOpenAI', { requestsPerMinute: 1 });
    limiter.setLimit('OpenAI', { requestsPerMinute: 1 });

    await limiter.acquire('AzureOpenAI');
    const openAiLease = await limiter.acquire('OpenAI');

    expect(openAiLease.admittedAt).toBe(0);
    expect(clock.sleeps).toEqual([]);
    expect(delays).toEqual([]);
  });

  it('rejects a request estimate that can never fit within TPM', async () => {
    limiter.setLimit('AzureOpenAI', { tokensPerMinute: 100 });

    await expect(limiter.acquire('AzureOpenAI', { estimatedTokens: 101 }))
      .rejects
      .toThrow(RateLimitExceededError);
    expect(clock.sleeps).toEqual([]);
    expect(delays).toEqual([]);
  });

  it('bypasses scheduling when a provider limit is disabled', async () => {
    limiter.setLimit('AzureOpenAI', {
      enabled: false,
      requestsPerMinute: 1,
      tokensPerMinute: 1,
    });

    await limiter.acquire('AzureOpenAI', { estimatedTokens: 1 });
    const second = await limiter.acquire('AzureOpenAI', { estimatedTokens: 1 });

    expect(second.admittedAt).toBe(0);
    expect(clock.sleeps).toEqual([]);
    expect(delays).toEqual([]);
  });

  it('treats non-positive or non-finite limits as unset', async () => {
    limiter.setLimit('AzureOpenAI', {
      requestsPerMinute: 0,
      tokensPerMinute: Number.NaN,
    });

    await limiter.acquire('AzureOpenAI', { estimatedTokens: 1000 });
    const second = await limiter.acquire('AzureOpenAI', { estimatedTokens: 1000 });

    expect(second.admittedAt).toBe(0);
    expect(clock.sleeps).toEqual([]);
    expect(delays).toEqual([]);
  });
});
