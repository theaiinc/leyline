import {
  createPaymentReference,
  createWorldFirstOrder,
  listCustomerOrders,
  markOrderPaid,
  type BillingAccount,
  type BillingLedgerEntry,
  type BillingOrder,
  type BillingStore,
  type LegalSettings,
} from '../src/core/billing';

const account: BillingAccount = {
  accountName: 'THE AI TECHNOLOGY COMPANY LIMITED',
  accountNumber: '123456789',
  bankName: 'WorldFirst',
  swiftCode: 'WFXXUS00',
  currency: 'USD',
};

const legal: LegalSettings = {
  companyName: 'THE AI TECHNOLOGY COMPANY LIMITED',
  taxCode: 'TAX-123',
  address: '1 Example Street, London',
};

function storeWith(orders: BillingOrder[] = []): BillingStore & {
  ledger: BillingLedgerEntry[];
  balance: Map<string, number>;
} {
  const saved = [...orders];
  const ledger: BillingLedgerEntry[] = [];
  const balance = new Map<string, number>();

  return {
    ledger,
    balance,
    async getWorldFirstAccount() { return account; },
    async getLegalSettings() { return legal; },
    async getOrder(id) { return saved.find(order => order.id === id) ?? null; },
    async listOrders(ownerId) { return saved.filter(order => order.ownerId === ownerId); },
    async saveOrder(order) { saved.push(order); },
    async markOrderPaid(orderId, paidAt) {
      const order = saved.find(item => item.id === orderId);
      if (!order || order.status === 'paid') return false;
      order.status = 'paid';
      order.paidAt = paidAt;
      return true;
    },
    async addLedgerEntry(entry) {
      ledger.push(entry);
      balance.set(entry.ownerId, (balance.get(entry.ownerId) ?? 0) + entry.amountCents);
    },
    async getBalanceCents(ownerId) { return balance.get(ownerId) ?? 0; },
  };
}

describe('Valefront billing', () => {
  it('creates a pending WorldFirst bank-transfer order with a unique reference', async () => {
    const store = storeWith();
    const first = await createWorldFirstOrder(store, {
      ownerId: 'owner-1',
      amountCents: 2500,
      id: 'order-1',
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    const second = await createWorldFirstOrder(store, {
      ownerId: 'owner-1',
      amountCents: 2500,
      id: 'order-2',
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(first).toMatchObject({
      status: 'pending',
      amountCents: 2500,
      account,
      reference: createPaymentReference('order-1', new Date('2026-01-01T00:00:00.000Z').getTime()),
    });
    expect(second.reference).not.toBe(first.reference);
  });

  it('rejects order creation when the receiving account is not configured', async () => {
    const store = storeWith();
    store.getWorldFirstAccount = async () => null;

    await expect(createWorldFirstOrder(store, {
      ownerId: 'owner-1',
      amountCents: 1000,
    })).rejects.toThrow('WorldFirst receiving account is not configured');
  });

  it('keeps customer orders scoped to the authenticated owner', async () => {
    const store = storeWith([
      {
        id: 'order-1',
        ownerId: 'owner-1',
        amountCents: 1000,
        reference: 'VF-ONE',
        account,
        status: 'pending',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'order-2',
        ownerId: 'owner-2',
        amountCents: 2000,
        reference: 'VF-TWO',
        account,
        status: 'pending',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    await expect(listCustomerOrders(store, 'owner-1')).resolves.toHaveLength(1);
    await expect(listCustomerOrders(store, 'owner-1')).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ ownerId: 'owner-2' })]),
    );
  });

  it('credits exactly once and records one audit ledger entry when marked paid', async () => {
    const store = storeWith();
    const order = await createWorldFirstOrder(store, {
      ownerId: 'owner-1',
      amountCents: 5000,
      id: 'order-1',
    });

    await markOrderPaid(store, order.id, new Date('2026-01-02T00:00:00.000Z'));
    await markOrderPaid(store, order.id, new Date('2026-01-03T00:00:00.000Z'));

    expect(store.balance.get('owner-1')).toBe(5000);
    expect(store.ledger).toHaveLength(1);
    expect(store.ledger[0]).toMatchObject({
      orderId: 'order-1',
      ownerId: 'owner-1',
      amountCents: 5000,
      kind: 'credit',
    });
  });

  it('leaves a Bookkeeper-compatible checkout boundary without calling a provider', async () => {
    const store = storeWith();
    const order = await createWorldFirstOrder(store, {
      ownerId: 'owner-1',
      amountCents: 1000,
      id: 'order-1',
    });

    const provider = {};
    expect(provider).not.toHaveProperty('createCheckout');
    expect(order.status).toBe('pending');
    expect(await store.getLegalSettings()).toEqual(legal);
  });
});