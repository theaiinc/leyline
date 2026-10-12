import { createHash } from 'crypto';
import axios from 'axios';
import { Provider, CompletionRequest, CompletionResponse, StreamChunk, ModelDetail } from '../core/types';
import { contentText, estimateBodyTokens } from '../core/content';

type ToolRecord = Record<string, unknown>;

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

function sha256(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(stableJson(value), 'utf8');
}

/** Characters of a message's content: the string, or the text of its parts plus the JSON of the rest. */
function contentCharLength(content: unknown): number {
  if (content === null || content === undefined) return 0;
  if (typeof content === 'string') return content.length;
  return stableJson(content).length;
}

function nonTextPartCount(content: unknown): number {
  return Array.isArray(content) ? content.filter(part => !isRecord(part) || part.type !== 'text').length : 0;
}

function messageSummary(messages: unknown): { count: number; contentChars: number; textChars: number; nonTextParts: number; sha256: string } {
  const list = Array.isArray(messages) ? messages : messages === undefined ? [] : [messages];
  const contentOf = (message: unknown) => (isRecord(message) ? message.content : message);
  return {
    count: list.length,
    contentChars: list.reduce((sum: number, message) => sum + contentCharLength(contentOf(message)), 0),
    // Text only (images/audio/files counted separately), so the audit compares what the model reads as text.
    textChars: list.reduce((sum: number, message) => sum + contentText(contentOf(message)).length, 0),
    nonTextParts: list.reduce((sum: number, message) => sum + nonTextPartCount(contentOf(message)), 0),
    sha256: sha256(messages),
  };
}

function toolSummary(tools: unknown): { count: number; sha256?: string } {
  if (!Array.isArray(tools)) return { count: 0 };
  return { count: tools.length, sha256: sha256(tools) };
}

function auditPayload(request: CompletionRequest, payload: Record<string, unknown>): void {
  if (process.env.LITELLM_PAYLOAD_AUDIT !== 'true') return;

  const inboundTools = toolSummary(request.tools);
  const outboundTools = toolSummary(payload.tools);
  const audit = {
    model: payload.model,
    stream: payload.stream,
    inbound: {
      messages: messageSummary(request.messages),
      tools: inboundTools,
    },
    outbound: {
      messages: messageSummary(payload.messages),
      tools: outboundTools,
      payloadBytes: byteLength(payload),
      payloadSha256: sha256(payload),
    },
    preserved: {
      messageCount: messageSummary(request.messages).count === messageSummary(payload.messages).count,
      messageContentChars: messageSummary(request.messages).contentChars === messageSummary(payload.messages).contentChars,
      nonTextParts: messageSummary(request.messages).nonTextParts === messageSummary(payload.messages).nonTextParts,
      toolCount: inboundTools.count === outboundTools.count,
    },
  };

  console.log(`[LiteLLM] Payload audit ${JSON.stringify(audit)}`);
}

function optionalPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function estimatePayloadTokens(payload: Record<string, unknown>): number {
  // Conservative proxy estimate: JSON payload chars include messages, tool schemas,
  // response hints, and Cursor metadata that provider tokenizers also need to process.
  // Inline images/audio count as a fixed estimate each, not by the length of their base64.
  const charsPerToken = optionalPositiveInteger(process.env.LITELLM_TOKEN_CHAR_RATIO) || 4;
  return estimateBodyTokens(payload, charsPerToken);
}

function contextLengthError(estimatedTokens: number, maxInputTokens: number): unknown {
  const message = `Estimated LiteLLM input is ${estimatedTokens} tokens, above configured limit ${maxInputTokens}. Reduce Cursor context or raise LITELLM_MAX_INPUT_TOKENS if your Azure deployment supports it.`;
  return {
    message,
    response: {
      status: 400,
      data: {
        error: {
          message,
          type: 'invalid_request_error',
          code: 'context_length_exceeded',
        },
      },
    },
  };
}

function isRecord(value: unknown): value is ToolRecord {
  return typeof value === 'object' && value !== null;
}

function sanitizeCustomFormat(format: unknown): ToolRecord | undefined {
  if (!isRecord(format)) return undefined;
  if (format.type === 'grammar' && !isRecord(format.grammar)) {
    return { type: 'text' };
  }
  return format;
}

function normalizeFunctionTool(tool: ToolRecord): ToolRecord | null {
  const nested = tool.function;
  if (isRecord(nested)) {
    if (typeof nested.name !== 'string' || !nested.name) return null;
    return {
      type: 'function',
      function: {
        name: nested.name,
        ...(typeof nested.description === 'string' ? { description: nested.description } : {}),
        ...(nested.parameters !== undefined
          ? { parameters: nested.parameters }
          : { parameters: { type: 'object', properties: {} } }),
        ...(nested.strict !== undefined ? { strict: nested.strict } : {}),
      },
    };
  }

  if (typeof tool.name !== 'string' || !tool.name) return null;
  return {
    type: 'function',
    function: {
      name: tool.name,
      ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
      ...(tool.parameters !== undefined
        ? { parameters: tool.parameters }
        : { parameters: { type: 'object', properties: {} } }),
      ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
    },
  };
}

function normalizeCustomTool(tool: ToolRecord): ToolRecord | null {
  const nested = tool.custom;
  const source = isRecord(nested) ? nested : tool;
  if (typeof source.name !== 'string' || !source.name) return null;

  const format = sanitizeCustomFormat(source.format);
  return {
    type: 'custom',
    name: source.name,
    ...(typeof source.description === 'string' ? { description: source.description } : {}),
    ...(format ? { format } : {}),
  };
}

function normalizeLiteLLMTool(tool: unknown): ToolRecord | null {
  if (!isRecord(tool)) return null;
  if (tool.type === 'function') return normalizeFunctionTool(tool);
  if (tool.type === 'custom') return normalizeCustomTool(tool);
  return tool;
}

function normalizeLiteLLMTools(tools: unknown): ToolRecord[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const normalized = tools
    .map(normalizeLiteLLMTool)
    .filter((tool): tool is ToolRecord => tool !== null);
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * LiteLLM proxy provider.
 *
 * Leyline delegates OpenAI/Azure compatibility details to LiteLLM and forwards
 * OpenAI-compatible payloads with minimal tool-shape normalization for LiteLLM.
 */
export class LiteLLMProvider implements Provider {
  name = 'LiteLLM';
  defaultModel: string;
  private baseUrl: string;
  private model: string;
  private apiKey: string;
  private maxInputTokens?: number;

  constructor(
    baseUrl: string = process.env.LITELLM_BASE_URL || 'http://127.0.0.1:4000/v1',
    model: string = process.env.LITELLM_MODEL || process.env.AZURE_OPENAI_DEFAULT_MODEL || process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-5.5',
    apiKey: string = process.env.LITELLM_API_KEY || 'not-needed',
    maxInputTokens: number | undefined = optionalPositiveInteger(
      process.env.LITELLM_MAX_INPUT_TOKENS || process.env.AZURE_OPENAI_MAX_INPUT_TOKENS,
    ),
    private preflightEnabled: boolean = process.env.LEYLINE_LITELLM_PREFLIGHT_ENABLED === 'true',
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.defaultModel = model;
    this.apiKey = apiKey;
    this.maxInputTokens = maxInputTokens;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await axios.get(`${this.baseUrl}/models`, {
        headers: this.headers(),
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }

  async getModels(): Promise<ModelDetail[]> {
    try {
      const response = await axios.get(`${this.baseUrl}/models`, {
        headers: this.headers(),
        timeout: 30000,
      });
      return (response.data?.data || []).map((m: any) => ({
        id: m.id,
        name: m.id,
      }));
    } catch (error) {
      console.error('[LiteLLM] Failed to list models:', error);
      return this.defaultModel ? [{ id: this.defaultModel, name: this.defaultModel }] : [];
    }
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const response = await axios.post(
      `${this.baseUrl}/chat/completions`,
      this.payload(request, false),
      {
        headers: this.headers(),
        timeout: 300000,
      },
    );

    return response.data;
  }

  async *completeStream(request: CompletionRequest): AsyncGenerator<StreamChunk, void, unknown> {
    const response = await axios.post(
      `${this.baseUrl}/chat/completions`,
      this.payload(request, true),
      {
        headers: this.headers(),
        responseType: 'stream',
        timeout: 300000,
      },
    );

    const stream: any = response.data;
    let buffer = '';

    const parseLine = (line: string): StreamChunk | 'done' | undefined => {
      const trimmed = line.trim();
      if (!trimmed) return undefined;
      if (!trimmed.startsWith('data: ')) return undefined;

      const data = trimmed.slice('data: '.length);
      if (data === '[DONE]') return 'done';

      try {
        return JSON.parse(data);
      } catch {
        return undefined;
      }
    };

    for await (const chunk of stream) {
      buffer += chunk.toString();

      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        const parsed = parseLine(line);
        if (parsed === 'done') return;
        if (parsed) yield parsed;

        newlineIndex = buffer.indexOf('\n');
      }
    }

    const parsed = parseLine(buffer);
    if (parsed && parsed !== 'done') yield parsed;
  }

  private payload(request: CompletionRequest, stream: boolean): Record<string, unknown> {
    const { model: requestedModel, stream: _stream, stream_options, tools, ...rest } = request;
    const payload: Record<string, unknown> = {
      ...rest,
      model: requestedModel === 'auto' ? this.model : requestedModel || this.model,
      stream,
    };

    if (stream) {
      payload.stream_options = {
        ...(typeof stream_options === 'object' && stream_options !== null ? stream_options : {}),
        include_usage: true,
      };
    } else if (stream_options !== undefined) {
      payload.stream_options = stream_options;
    }

    if (tools !== undefined) {
      payload.tools = normalizeLiteLLMTools(tools);
      if (!payload.tools) {
        delete payload.tool_choice;
        delete payload.parallel_tool_calls;
      }
    }

    auditPayload(request, payload);

    if (this.preflightEnabled && this.maxInputTokens) {
      const estimatedTokens = estimatePayloadTokens(payload);
      if (estimatedTokens > this.maxInputTokens) {
        throw contextLengthError(estimatedTokens, this.maxInputTokens);
      }
    }

    return payload;
  }

  private headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }
}
