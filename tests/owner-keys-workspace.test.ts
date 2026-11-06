import request from 'supertest';
import { hostedBilling } from './helpers/hosted-billing';
import { workspace } from './helpers/billing-fixture';

const ADMIN = { Authorization: 'Bearer admin-secret-token' };

describe('owner keys onto an admin workspace', () => {
  async function setup() {
    const h = hostedBilling();
    const own = await workspace(h.store, { email: 'owner@valefront.com' });
    const customer = await workspace(h.store, { email: 'someone@example.com' });
    const { key, record } = await h.keys.create({ name: 'simasis', by: 'token' });
    return { ...h, own, customer, key, record };
  }

  it('moves the key: it still works, is listed on the workspace, and is never charged', async () => {
    const h = await setup();
    const res = await request(h.app).post(`/admin/api/keys/${h.record.id}/workspace`).set(ADMIN).send({ workspaceId: h.own.id });
    expect(res.status).toBe(200);
    expect(res.body.record).toMatchObject({ id: h.record.id, workspaceId: h.own.id });
    expect((await h.keys.listForWorkspace(h.own.id)).map((k) => k.id)).toEqual([h.record.id]);
    // The same key keeps working (the admin workspace has $0 credit and isn't asked for any).
    const chat = await request(h.app).post('/v1/chat/completions').set('Authorization', `Bearer ${h.key}`).send({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }] });
    expect(chat.status).toBe(200);
    await h.settle();
    expect((await h.store.balance(h.own.id)).availableMicros).toBe(0);
    // Repeating it is harmless.
    expect((await request(h.app).post(`/admin/api/keys/${h.record.id}/workspace`).set(ADMIN).send({ workspaceId: h.own.id })).status).toBe(200);
    expect((await h.keys.listForWorkspace(h.own.id)).length).toBe(1);
  });

  it('refuses a customer workspace, a revoked key, a key of another workspace, and needs the admin', async () => {
    const h = await setup();
    expect((await request(h.app).post(`/admin/api/keys/${h.record.id}/workspace`).send({ workspaceId: h.own.id })).status).toBe(401);
    expect((await request(h.app).post(`/admin/api/keys/${h.record.id}/workspace`).set(ADMIN).send({ workspaceId: h.customer.id })).status).toBe(403);
    expect((await request(h.app).post(`/admin/api/keys/${h.record.id}/workspace`).set(ADMIN).send({ workspaceId: 'ws_nope' })).status).toBe(404);
    const other = await h.keys.create({ name: 'cust', by: 'someone@example.com', workspaceId: h.customer.id });
    expect((await request(h.app).post(`/admin/api/keys/${other.record.id}/workspace`).set(ADMIN).send({ workspaceId: h.own.id })).status).toBe(409);
    const gone = await h.keys.create({ name: 'old', by: 'token' });
    await h.keys.revoke(gone.record.id);
    expect((await request(h.app).post(`/admin/api/keys/${gone.record.id}/workspace`).set(ADMIN).send({ workspaceId: h.own.id })).status).toBe(409);
  });
});
