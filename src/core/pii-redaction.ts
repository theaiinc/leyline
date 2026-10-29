import { MaskPiiTransformer, TokenRehydrator, Veil, VeilRegistry } from '@theaiinc/veil';
  import { RegexDetector } from '@theaiinc/veil-regex';

  export type PiiRedactionMode = 'off' | 'regex' | 'presidio';

  export type PiiRedactionOptions = {
    mode?: PiiRedactionMode;
    allowlist?: string[];
    presidioAnalyzerUrl?: string;
    log?: (event: { event: 'pii_redaction'; mode: PiiRedactionMode; latencyMs: number; counts: Record<string, number> }) => void;
  };

  export type PiiRedactionStats = {
    mode: PiiRedactionMode;
    counts: Record<string, number>;
    latencyMs: number;
    presidioFallback: boolean;
  };

  const TOKEN_PATTERN = /<([a-z-]+):\d+>/gi;

  function compileAllowlist(patterns: string[]): RegExp[] {
    return patterns.flatMap((pattern) => {
      try {
        return [new RegExp(pattern, 'g')];
      } catch {
        return [];
      }
    });
  }

  function protectAllowlisted(input: string, patterns: RegExp[]): { value: string; restore: (output: string) => string } {
    const values: string[] = [];
    let value = input;
    for (const pattern of patterns) {
      value = value.replace(pattern, (match) => {
        const index = values.push(match) - 1;
        return `<veil-allowlist:${index}>`;
      });
    }
    return {
      value,
      restore: (output: string) => output.replace(/<veil-allowlist:(\d+)>/g, (_match, index: string) => values[Number(index)] ?? ''),
    };
  }

  function textParts(value: unknown): string[] {
    if (typeof value === 'string') return [value];
    if (!Array.isArray(value)) return [];
    return value.flatMap((part) => part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
      ? [(part as { text: string }).text]
      : []);
  }

  export class RequestPiiRedactor {
    private readonly veil: Veil;
    private readonly allowlist: RegExp[];
    private readonly opts: PiiRedactionOptions;
    private readonly mappings = new Map<string, string>();
    private readonly counts: Record<string, number> = {};
    private readonly mode: PiiRedactionMode;
    private readonly startedAt = Date.now();
    private readonly fallback: boolean;
    private streamBuffer = '';

    constructor(options: PiiRedactionOptions = {}) {
      this.opts = options;
      this.mode = options.mode ?? 'off';
      this.allowlist = compileAllowlist(options.allowlist ?? []);
      this.fallback = this.mode === 'presidio' && !options.presidioAnalyzerUrl;
      const registry = Veil.defaultRegistry();
      if (this.mode !== 'off') registry.registerDetector(new RegexDetector());
      this.veil = new Veil(registry);
    }

    get stats(): PiiRedactionStats {
      return {
        mode: this.mode,
        counts: { ...this.counts },
        latencyMs: Date.now() - this.startedAt,
        presidioFallback: this.fallback,
      };
    }

    private async redactText(input: string): Promise<string> {
      if (this.mode === 'off' || !input) return input;
      const protectedValue = protectAllowlisted(input, this.allowlist);
      const result = await this.veil.process({ content: protectedValue.value, profile: 'public-cloud' });
      for (const mapping of result.mappings) {
        const token = String(mapping.token);
        this.mappings.set(token, mapping.originalValue);
        const rawType = token.match(TOKEN_PATTERN)?.[1]
          ?? String((mapping as { entityType?: unknown; type?: unknown }).entityType ?? (mapping as { type?: unknown }).type ?? 'unknown');
        const normalizedType = rawType.toLowerCase().replace(/[_-]+/g, '');
        const original = String(mapping.originalValue);
        const inferredType = /@[^\s@]+\.[^\s@]+/.test(original) ? 'email'
          : /(?:\+?\d[\d\s().-]{6,}\d)/.test(original) ? 'phone'
          : rawType.toLowerCase();
        const type = normalizedType === 'email' || normalizedType === 'emailaddress' ? 'email'
          : normalizedType === 'phone' || normalizedType === 'phonenumber' ? 'phone'
          : normalizedType === 'name' || normalizedType === 'person' || normalizedType === 'personname' ? 'name'
          : normalizedType === 'address' || normalizedType === 'location' ? 'address'
          : inferredType;
        this.counts[type] = (this.counts[type] ?? 0) + 1;
      }
      return protectedValue.restore(result.transformedContent);
    }

    async redact<T>(value: T): Promise<T> {
      if (this.mode === 'off' || value == null) return value;
      if (typeof value === 'string') return await this.redactText(value) as T;
      if (Array.isArray(value)) return await Promise.all(value.map((item) => this.redact(item))) as T;
      if (typeof value === 'object') {
        const output: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
          output[key] = await this.redact(item);
        }
        return output as T;
      }
      return value;
    }

    rehydrate(value: string): string {
      if (this.mode === 'off' || !value) return value;
      this.streamBuffer += value;
      let safeEnd = this.streamBuffer.length;
      const partial = this.streamBuffer.lastIndexOf('<');
      if (partial >= 0 && /^[<][a-z-]*:?\d*$/.test(this.streamBuffer.slice(partial))) safeEnd = partial;
      let output = this.streamBuffer.slice(0, safeEnd);
      this.streamBuffer = this.streamBuffer.slice(safeEnd);
      for (const [token, original] of this.mappings) output = output.split(token).join(original);
      return output;
    }

    rehydrateValue<T>(value: T): T {
      if (typeof value === 'string') return this.rehydrate(value) as T;
      if (Array.isArray(value)) return value.map((item) => this.rehydrateValue(item)) as T;
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, this.rehydrateValue(item)])) as T;
      }
      return value;
    }

    finishStream(): string {
      let output = this.streamBuffer;
      this.streamBuffer = '';
      for (const [token, original] of this.mappings) output = output.split(token).join(original);
      return output;
    }

    async finish(): Promise<PiiRedactionStats> {
      const stats = this.stats;
      if (this.mode !== 'off' && Object.keys(this.counts).length) {
        this.opts.log?.({ event: 'pii_redaction', mode: this.mode, latencyMs: stats.latencyMs, counts: { ...this.counts } });
      }
      return stats;
    }
  }