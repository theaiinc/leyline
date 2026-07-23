import request from 'supertest';
import { createServer } from '../src/server';
import { Router } from '../src/core/router';
import { QuotaManager } from '../src/core/quota-manager';
import { LEYLINE_CLIENT_AUTH_HEADER } from './client-auth-header';

function createApp() {
  return createServer(new Router(new QuotaManager()), new QuotaManager());
}

describe('server network boundary', () => {
  it('exposes readiness only on the internal loopback surface', async () => {
    const app = createApp();

    const internal = await request(app).get('/healthz');
    const external = await request(app).get('/healthz').set('x-forwarded-for', '203.0.113.10');

    expect(internal.status).toBe(200);
    expect(internal.body).toEqual({ status: 'ok', service: 'leyline' });
    expect(external.status).toBe(404);
    expect(external.body.error.code).toBe('external_endpoint_not_exposed');
  });

  it('blocks dashboard and static assets through proxy headers', async () => {
    const app = createApp();

    const dashboard = await request(app).get('/dashboard/stats').set('cf-ray', 'test-ray');
    const logo = await request(app).get('/logo.png').set('x-forwarded-for', '203.0.113.10');

    expect(dashboard.status).toBe(403);
    expect(logo.status).toBe(404);
  });

  it('keeps authenticated API routes available through proxy headers', async () => {
    const app = createApp();

    const response = await request(app)
      .post('/v1/route')
      .set('x-forwarded-for', '203.0.113.10')
      .set(LEYLINE_CLIENT_AUTH_HEADER)
      .send({ user_message: 'hello' });

    expect(response.status).toBe(200);
  });
});
