import http from 'http';
import { JanusTunnel } from '../src/core/janus-tunnel';

function startJanusStub(endpoint: unknown) {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    if (req.method === 'PUT' && req.url === '/api/namespaces/leyline/aliases/api') {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    if (req.url === '/api/namespaces/leyline/aliases/api/endpoint') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(endpoint));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise<{ server: http.Server; baseUrl: string }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

function startAuthenticatedJanusStub(endpoint: unknown) {
  const headers: string[] = [];
  const server = http.createServer((req, res) => {
    headers.push(req.headers.authorization || '');
    if (req.url === '/api/status') {
      if (req.headers.authorization !== 'Bearer stored-key') {
        res.writeHead(401);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    if (req.url === '/api/namespaces/leyline/aliases/api/endpoint') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(endpoint));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise<{ server: http.Server; baseUrl: string; headers: string[] }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}`, headers });
    });
  });
}

describe('JanusTunnel', () => {
  it('publishes the active registered Janus tunnel URL', async () => {
    const stub = await startJanusStub({ url: 'https://leyline.example.com', status: 'healthy' });
    const tunnel = new JanusTunnel({
      enabled: true,
      command: 'janus',
      baseUrl: stub.baseUrl,
      serviceId: 'leyline',
      namespace: 'leyline',
      alias: 'api',
      startupTimeoutMs: 100,
      autoStart: false,
    });

    await expect(tunnel.start('http://127.0.0.1:3000')).resolves.toMatchObject({
      state: 'ready',
      publicUrl: 'https://leyline.example.com',
      publicBaseUrl: 'https://leyline.example.com/v1',
    });
    stub.server.close();
  });

  it('reports an error when Janus has no active tunnel URL', async () => {
    const stub = await startJanusStub({ status: 'offline' });
    const tunnel = new JanusTunnel({
      enabled: true,
      command: 'janus',
      baseUrl: stub.baseUrl,
      serviceId: 'leyline',
      namespace: 'leyline',
      alias: 'api',
      startupTimeoutMs: 100,
      autoStart: false,
    });

    await expect(tunnel.start('http://127.0.0.1:3000')).resolves.toMatchObject({
      state: 'error',
    });
    stub.server.close();
  });

  it('uses a stored Janus API key for authenticated discovery', async () => {
    const stub = await startAuthenticatedJanusStub({ url: 'https://leyline.example.com', status: 'healthy' });
    const tunnel = new JanusTunnel({
      enabled: true,
      command: 'janus',
      baseUrl: stub.baseUrl,
      serviceId: 'leyline',
      namespace: 'leyline',
      alias: 'api',
      startupTimeoutMs: 100,
      autoStart: false,
      apiKey: 'stored-key',
    });

    await expect(tunnel.start('http://127.0.0.1:3000')).resolves.toMatchObject({
      state: 'ready',
      publicUrl: 'https://leyline.example.com',
    });
    expect(stub.headers).toContain('Bearer stored-key');
    stub.server.close();
  });
});
