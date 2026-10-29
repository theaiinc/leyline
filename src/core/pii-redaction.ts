import { MaskPiiTransformer, TokenRehydrator, Veil, VeilRegistry } from '@theaiinc/veil';
  import { RegexDetector } from '@theaiinc/veil-regex';
import { PresidioDetector } from '@theaiinc/veil-presidio';

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
    private streamBuffers = new Map<string, string>();

    /** True when Presidio was requested but no analyzer endpoint is configured. */
    get presidioUnavailable(): boolean {
      return this.fallback;
    }

    constructor(options: PiiRedactionOptions = {}) {
      this.opts = options;
      this.mode = options.mode ?? 'off';
      this.allowlist = compileAllowlist(options.allowlist ?? []);
      this.fallback = this.mode === 'presidio' && !options.presidioAnalyzerUrl;
      const registry = Veil.defaultRegistry();
      if (this.mode === 'regex' || this.fallback) registry.registerDetector(new RegexDetector());
      if (this.mode === 'presidio' && options.presidioAnalyzerUrl) {
        registry.registerDetector(new PresidioDetector({ analyzerUrl: options.presidioAnalyzerUrl }));
      }
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
      const result = await this.veil.process({ content: protectedValue.value });
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
      if (typeof value !== 'object') return value;
      const request = value as Record<string, unknown>;
      if (!Array.isArray(request.messages)) return value;
      const redactBlock = async (part: unknown): Promise<unknown> => {
        if (!part || typeof part !== 'object') return part;
        const block = { ...(part as Record<string, unknown>) };
        if (typeof block.text === 'string') block.text = await this.redactText(block.text);
        if (block.type === 'tool_result') {
          if (typeof block.content === 'string') block.content = await this.redactText(block.content);
          else if (Array.isArray(block.content)) block.content = await Promise.all(block.content.map(redactBlock));
        }
        return block;
      };
      const messages = await Promise.all(request.messages.map(async (message) => {
        if (!message || typeof message !== 'object') return message;
        const copy = { ...(message as Record<string, unknown>) };
        // Only message content is PII-bearing input. Do not walk or clone tools,
        // tool_choice, response_format, metadata, image data, or other request fields.
        if (typeof copy.content === 'string') copy.content = await this.redactText(copy.content);
        else if (Array.isArray(copy.content)) copy.content = await Promise.all(copy.content.map(redactBlock));
        // Anthropic tool results can be represented as a top-level message content
        // block; redactBlock handles only text-bearing blocks and preserves all else.
        return copy;
      }));
      return { ...request, messages } as T;
    }

    private replace(value: string): string {
      if (this.mode === 'off' || !value) return value;
      let output = value;
      for (const [token, original] of this.mappings) output = output.split(token).join(original);
      return output;
    }

    rehydrateValue<T>(value: T): T {
      if (typeof value === 'string') return this.replace(value) as T;
      if (Array.isArray(value)) return value.map((item) => this.rehydrateValue(item)) as T;
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, this.rehydrateValue(item)])) as T;
      return value;
    }

    /** Rehydrate a complete, non-streamed value without retaining a partial-token buffer. */
    rehydrate(value: string): string {
      return this.replace(value);
    }

    /** Rehydrate a streamed delta, retaining only a possible incomplete Veil token for this channel. */
    rehydrateStream(value: string, streamKey = 'default'): string {
      if (this.mode === 'off' || !value) return value;
      const combined = (this.streamBuffers.get(streamKey) ?? '') + value;
      const tokenStart = combined.lastIndexOf('<');
      if (tokenStart < 0) {
        this.streamBuffers.delete(streamKey);
        return this.replace(combined);
      }
      const suffix = combined.slice(tokenStart);
      if (!/^<[a-z-]*:?\d*$/.test(suffix) || suffix.length > 128) {
        this.streamBuffers.delete(streamKey);
        return this.replace(combined);
      }
      this.streamBuffers.set(streamKey, suffix);
      return this.replace(combined.slice(0, tokenStart));
    }

    finishStream(streamKey = 'default'): string {
      const pending = this.streamBuffers.get(streamKey) ?? '';
      this.streamBuffers.delete(streamKey);
      return this.replace(pending);
    }

    async finish(): Promise<PiiRedactionStats> {
      const stats = this.stats;
      if (this.mode !== 'off' && Object.keys(this.counts).length) {
        this.opts.log?.({ event: 'pii_redaction', mode: this.mode, latencyMs: stats.latencyMs, counts: { ...this.counts } });
      }
      return stats;
    }
  }