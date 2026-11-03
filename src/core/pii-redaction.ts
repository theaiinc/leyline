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

  // Plain-word placeholders survive HTML/JSON/code generation without being escaped or reinterpreted.
  // VF_<TYPE>_<N>X is made only from word characters, so models do not HTML-escape or reinterpret it.
  const TOKEN_PATTERN = /\bVF_[A-Z][A-Z0-9_]*\d+X\b/g;
  const LEGACY_TOKEN_PATTERN = /(?:&lt;|\\?<)([a-z-]+:\d+)(?:&gt;|\\?>)/gi;
  const PARTIAL_TOKEN_PATTERN = /(VF(?:_[A-Z][A-Z0-9_]*)?)$/;

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
    private readonly legacyTypes = new Map<string, string>();
    private readonly requestTokens = new Map<string, string>();
    private readonly counts: Record<string, number> = {};
    private nextToken = 1;
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
      const registry = new VeilRegistry();
      registry.registerTransformer(new MaskPiiTransformer());
      registry.registerRehydrator(new TokenRehydrator());
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
      const replacements = new Map<string, string>();
      for (const mapping of result.mappings) {
        const veilToken = String(mapping.token);
        const original = String(mapping.originalValue);
        const rawType = String((mapping as { entityType?: unknown; type?: unknown }).entityType ?? (mapping as { type?: unknown }).type ?? veilToken.match(/<([a-z-]+):\d+>/i)?.[1] ?? 'unknown');
        const normalizedType = rawType.toLowerCase().replace(/[_-]+/g, '');
        const isUrl = /^(?:https?:\/\/|ftp:\/\/|www\.)/i.test(original) || /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/:?#]|$)/i.test(original);
        if (isUrl) {
          replacements.set(veilToken, original);
          continue;
        }
        let token = this.requestTokens.get(original);
        if (!token) {
          const type = normalizedType === 'email' || normalizedType === 'emailaddress' ? 'email'
            : normalizedType === 'phone' || normalizedType === 'phonenumber' ? 'phone'
            : normalizedType === 'name' || normalizedType === 'person' || normalizedType === 'personname' ? 'name'
            : normalizedType === 'address' || normalizedType === 'location' ? 'address'
            : /@[^\s@]+\.[^\s@]+/.test(original) ? 'email'
            : /(?:\+?\d[\d\s().-]{6,}\d)/.test(original) ? 'phone'
            : rawType.toLowerCase();
          const tokenType = type.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
          token = `VF_${tokenType}_${this.nextToken++}X`;
          this.requestTokens.set(original, token);
          this.mappings.set(token, original);
          this.legacyTypes.set(token, rawType.toLowerCase());
          this.counts[type] = (this.counts[type] ?? 0) + 1;
        }
        replacements.set(veilToken, token);
      }
      const transformed = result.transformedContent.replace(
        new RegExp(`${TOKEN_PATTERN.source}|(?:&lt;|\\\\?<)[a-z-]+:\\d+(?:&gt;|\\\\?>)`, 'gi'),
        (token) => replacements.get(token) ?? token,
      );
      return protectedValue.restore(transformed);
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
      const messages = [];
      for (const message of request.messages) {
        if (!message || typeof message !== 'object') return message;
        const copy = { ...(message as Record<string, unknown>) };
        // Only message content is PII-bearing input. Do not walk or clone tools,
        // tool_choice, response_format, metadata, image data, or other request fields.
        if (typeof copy.content === 'string') copy.content = await this.redactText(copy.content);
        else if (Array.isArray(copy.content)) copy.content = await Promise.all(copy.content.map(redactBlock));
        // Anthropic tool results can be represented as a top-level message content
        // block; redactBlock handles only text-bearing blocks and preserves all else.
        messages.push(copy);
      }
      return { ...request, messages } as T;
    }

    private replace(value: string): string {
      if (this.mode === 'off' || !value) return value;
      const replacements = new Map<string, string>();
      for (const [token, original] of this.mappings) {
        replacements.set(token, original);
        const match = token.match(/^VF_([A-Z][A-Z0-9_]*)_(\d+)X$/);
        if (!match) continue;
        const legacyType = this.legacyTypes.get(token) ?? match[1].toLowerCase();
        const legacy = `<${legacyType}:${match[2]}>`;
        replacements.set(legacy, original);
        replacements.set(`&lt;${legacyType}:${match[2]}&gt;`, original);
        replacements.set(`\\${legacy}`, original);
      }
      const allTokens = new RegExp(
        `${TOKEN_PATTERN.source}|(?:&lt;|\\\\?<)[a-z-]+:\\d+(?:&gt;|\\\\?>)`,
        'gi',
      );
      return value.replace(allTokens, (token) => {
        if (replacements.has(token)) return replacements.get(token)!;
        const normalized = token
          .replace(/^&lt;/i, '<')
          .replace(/^\\</, '<')
          .replace(/&gt;$/i, '>')
          .replace(/\\>$/, '>');
        return replacements.get(normalized) ?? token;
      });
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

    /** Rehydrate a streamed delta, retaining only a possible incomplete token for this channel. */
    rehydrateStream(value: string, streamKey = 'default'): string {
      if (this.mode === 'off' || !value) return value;
      const combined = (this.streamBuffers.get(streamKey) ?? '') + value;
      const issuedTokens = [...this.mappings.keys()];
      const legacyTokens = issuedTokens.flatMap((token) => {
        const match = token.match(/^VF_([A-Z][A-Z0-9_]*)_(\d+)X$/);
        const legacyType = this.legacyTypes.get(token) ?? match?.[1].toLowerCase();
        return match && legacyType
          ? [
              `<${legacyType}:${match[2]}>`,
              `&lt;${legacyType}:${match[2]}&gt;`,
              `\\<${legacyType}:${match[2]}\\>`,
            ]
          : [];
      });
      const allIssuedTokens = [...issuedTokens, ...legacyTokens];

      // Replace complete tokens first. Retain the longest non-empty suffix that
      // is a strict prefix of an issued token, even when the model split inside
      // the token before the underscore or type name (for example, `VF`).
      const replaced = this.replace(combined);
      // A complete token (including a legacy escaped token) has been resolved.
      // Do not run prefix buffering against the original text after replacement:
      // the resolved value may itself end in characters that resemble a token
      // prefix, and retaining that suffix would leak the placeholder.
      if (replaced !== combined) {
        this.streamBuffers.delete(streamKey);
        return replaced;
      }

      let partialSuffix = '';
      for (const token of allIssuedTokens) {
        const maxLength = Math.min(token.length - 1, combined.length);
        for (let length = 1; length <= maxLength; length += 1) {
          const suffix = combined.slice(-length);
          if (token.startsWith(suffix) && suffix.length > partialSuffix.length) {
            partialSuffix = suffix;
          }
        }
      }
      // Retain a syntactically valid token prefix even when the detector has
      // not issued that exact token (for example, a phone token may arrive
      // before its mapping is available to this stream channel).
      const genericPartialMatch = combined.match(/(VF(?:_[A-Z][A-Z0-9_]*)?)$/);
      const genericPartial = genericPartialMatch?.[1] ?? '';
      // Keep any syntactically valid VF prefix, including prefixes that have
      // not yet matched an issued token (for example VF_PH before VF_PHONE_2X).
      if (genericPartial.length > partialSuffix.length) partialSuffix = genericPartial;
      if (partialSuffix) {
        this.streamBuffers.set(streamKey, partialSuffix);
        return this.replace(combined.slice(0, -partialSuffix.length));
      }

      this.streamBuffers.delete(streamKey);
      return replaced;
    }

    get streamKeys(): string[] {
      return [...this.streamBuffers.keys()];
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