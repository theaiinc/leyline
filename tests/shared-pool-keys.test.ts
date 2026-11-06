import request from 'supertest';
import { hostedBilling } from './helpers/hosted-billing';
import { workspace } from './helpers/billing-fixture';

const ADMIN = { Authorization: 'Bearer admin-secret-token' };

describe('adm manages the shared pool only', () => {
  async function setup() {
    const h = hostedBilling();
    const own = await workspace(h.store, { email: 'owner@valefront.com' });
    const customer = await workspace(h.store, { email: 'someone@example.com' });
    const pool = await h.keys.create({ name: 'simasis', by: 'token' });
    const cust = await h.keys.create({ name: 'cust', by: 'someone@example.com', workspaceId: customer.id });
    return { ...h, own, customer, pool, cust };
  }

  it("lists only shared-pool keys, never a customer's", async () => {
    const h = await setup();
    const names = (await request(h.app).get('/admin/api/keys').set(ADMIN)).body.keys.map((k: { name: string }) => k.name);
    expect(names).toEqual(['simasis']);
  });

  it("a pool key that was put on the admin's workspace goes back to the pool and keeps working; customers' keys stay", async () => {
    const h = await setup();
    // As it was after 2026-11-06's move.
    const moved = await h.keys.create({ name: 'simasis-hosted', by: 'token', workspaceId: h.own.id });
    expect((await h.keys.listForWorkspace(h.own.id)).map((k) => k.id)).toEqual([moved.record.id]);
    const res = await request(h.app).post(`/admin/api/keys/${moved.record.id}/pool`).set(ADMIN);
    expect(res.status).toBe(200);
    expect(res.body.record.workspaceId).toBeUndefined();
    expect(await h.keys.listForWorkspace(h.own.id)).toEqual([]);
    expect((await request(h.app).get('/admin/api/keys').set(ADMIN)).body.keys.map((k: { name: string }) => k.name).sort()).toEqual(['simasis', 'simasis-hosted']);
    const chat = await request(h.app).post('/v1/chat/completions').set('Authorization', `Bearer ${moved.key}`).send({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] });
    expect(chat.status).toBe(200);
    expect((await request(h.app).post(`/admin/api/keys/${h.cust.record.id}/pool`).set(ADMIN)).status).toBe(403);
    expect((await request(h.app).post(`/admin/api/keys/${h.pool.record.id}/pool`)).status).toBe(401);
  });
});
