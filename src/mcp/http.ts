import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { Router } from '../core/router';
import type { CompletionRequest } from '../core/types';

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

const MCP_PROTOCOL_VERSION = '2025-06-18';
const sessions = new Set<string>();

function response(id: JsonRpcRequest['id'], result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function errorResponse(id: JsonRpcRequest['id'], code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function parseChatArguments(value: unknown): CompletionRequest {
  if (!value || typeof value !== 'object') throw new Error('arguments must be an object');
  const input = value as Partial<CompletionRequest>;
  if (typeof input.model !== 'string' || !Array.isArray(input.messages)) {
    throw new Error('arguments.model and arguments.messages are required');
  }
  return { ...input, model: input.model, messages: input.messages } as CompletionRequest;
}

async function handleMessage(router: Router, message: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return errorResponse(message.id, -32600, 'Invalid JSON-RPC request');
  }

  if (message.method === 'notifications/initialized' || message.method.startsWith('notifications/')) {
    return null;
  }

  if (message.method === 'initialize') {
    return response(message.id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'leyline', version: '1.3.3' },
    });
  }

  if (message.method === 'ping') return response(message.id, {});

  if (message.method === 'tools/list') {
    return response(message.id, {
      tools: [{
        name: 'leyline_chat',
        description: 'Route a chat completion through Leyline providers.',
        inputSchema: {
          type: 'object',
          required: ['model', 'messages'],
          properties: {
            model: { type: 'string' },
            messages: { type: 'array', items: { type: 'object' } },
          },
        },
      }],
    });
  }

  if (message.method === 'tools/call') {
    const params = message.params || {};
    if (params.name !== 'leyline_chat') {
      return errorResponse(message.id, -32602, 'Unknown tool');
    }

    try {
      const request = parseChatArguments(params.arguments);
      const result = await router.route(request);
      return response(message.id, {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
        isError: false,
      });
    } catch (error: any) {
      return response(message.id, {
        content: [{ type: 'text', text: error?.message || 'Leyline request failed' }],
        isError: true,
      });
    }
  }

  return errorResponse(message.id, -32601, `Method not found: ${message.method}`);
}

export function createMcpHttpHandler(router: Router) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const sessionId = req.header('Mcp-Session-Id');

    if (req.method === 'DELETE') {
      if (!sessionId || !sessions.delete(sessionId)) {
        res.status(404).json({ error: 'MCP session not found.' });
        return;
      }
      res.status(204).end();
      return;
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      res.status(405).json({ error: 'MCP Streamable HTTP requires POST requests.' });
      return;
    }

    const message = req.body as JsonRpcRequest;
    if (message?.method === 'initialize') {
      const newSession = randomUUID();
      sessions.add(newSession);
      res.setHeader('Mcp-Session-Id', newSession);
    } else if (!sessionId || !sessions.has(sessionId)) {
      res.status(400).json({ error: 'A valid Mcp-Session-Id is required after initialize.' });
      return;
    }

    try {
      const result = await handleMessage(router, message);
      if (result === null) {
        res.status(202).end();
        return;
      }
      res.type('application/json').json(result);
    } catch (error) {
      next(error);
    }
  };
}
