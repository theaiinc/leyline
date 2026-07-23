import request from 'supertest';
import { createServer } from '../src/server';
import { Router } from '../src/core/router';
import { QuotaManager } from '../src/core/quota-manager';
import { LEYLINE_CLIENT_AUTH_HEADER } from './client-auth-header';

function createApp() {
  const quotaManager = new QuotaManager();
  return createServer(new Router(quotaManager), quotaManager);
}

describe('MCP Streamable HTTP endpoint', () => {
  it('requires the Leyline client API key', async () => {
    const response = await request(createApp())
      .post('/mcp')
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });

    expect(response.status).toBe(401);
  });

  it('initializes an authenticated session and lists Leyline tools', async () => {
    const app = createApp();
    const initialize = await request(app)
      .post('/mcp')
      .set(LEYLINE_CLIENT_AUTH_HEADER)
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
      });

    expect(initialize.status).toBe(200);
    expect(initialize.headers['mcp-session-id']).toBeDefined();
    expect(initialize.body.result.serverInfo.name).toBe('leyline');

    const tools = await request(app)
      .post('/mcp')
      .set(LEYLINE_CLIENT_AUTH_HEADER)
      .set('Mcp-Session-Id', initialize.headers['mcp-session-id'])
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

    expect(tools.status).toBe(200);
    expect(tools.body.result.tools[0].name).toBe('leyline_chat');
  });

  it('rejects requests without a valid initialized session', async () => {
    const response = await request(createApp())
      .post('/mcp')
      .set(LEYLINE_CLIENT_AUTH_HEADER)
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

    expect(response.status).toBe(400);
  });

  it('allows an authenticated client to terminate its session', async () => {
    const app = createApp();
    const initialize = await request(app)
      .post('/mcp')
      .set(LEYLINE_CLIENT_AUTH_HEADER)
      .send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    const sessionId = initialize.headers['mcp-session-id'];

    const terminated = await request(app)
      .delete('/mcp')
      .set(LEYLINE_CLIENT_AUTH_HEADER)
      .set('Mcp-Session-Id', sessionId);

    expect(terminated.status).toBe(204);
    const afterDelete = await request(app)
      .post('/mcp')
      .set(LEYLINE_CLIENT_AUTH_HEADER)
      .set('Mcp-Session-Id', sessionId)
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(afterDelete.status).toBe(400);
  });

  it('does not expose MCP through an external path other than /mcp', async () => {
    const response = await request(createApp())
      .get('/healthz')
      .set('cf-connecting-ip', '203.0.113.10');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('external_endpoint_not_exposed');
  });
});
