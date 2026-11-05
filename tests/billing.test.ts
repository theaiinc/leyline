import {
  BillingError,
  cleanBuyerProfile,
  cleanVatInvoiceDetails,
  normalizeTaxCode,
  cleanVat,
  createPaymentReference,
  decimalToCents,
  documentNumber,
  formatUsd,
  validateCreditAmount,
  vatFor,
  vietnamDate,
} from '../src/core/billing';
import { SETTINGS } from '../src/core/billing-service';
import { BUYER, WORLDFIRST, billingFixture, workspace } from './helpers/billing-fixture';

describe('billing domain', () => {
  it('requires at least $10 of credit, in whole cents', () => {
    expect(() => validateCreditAmount(999)).toThrow('at least $10.00');
    expect(() => validateCreditAmount(1000.5)).toThrow(BillingError);
    expect(() => validateCreditAmount(1000)).not.toThrow();
    expect(() => validateCreditAmount(1_000_001)).toThrow('at most');
  });

  it('VAT: 0% for export of services, 10% for customers in Vietnam, admin-set rates win', () => {
    expect(vatFor(1000, 'GB')).toEqual({ vatRateBp: 0, vatCents: 0, totalCents: 1000 });
    expect(vatFor(1000, 'vn')).toEqual({ vatRateBp: 1000, vatCents: 100, totalCents: 1100 });
    expect(vatFor(1234, 'VN')).toEqual({ vatRateBp: 1000, vatCents: 123, totalCents: 1357 });
    expect(vatFor(2000, 'VN', { defaultBp: 0, byCountry: { VN: 800 } })).toEqual({ vatRateBp: 800, vatCents: 160, totalCents: 2160 });
    expect(() => cleanVat({ defaultBp: 0, byCountry: { VN: 20_000 } })).toThrow('basis points');
  });

  it('money formatting and parsing stays in integer cents', () => {
    expect(formatUsd(123456)).toBe('$1,234.56');
    expect(formatUsd(-5)).toBe('-$0.05');
    expect(decimalToCents('10')).toBe(1000);
    expect(decimalToCents('10.5')).toBe(1050);
    expect(decimalToCents('10.555')).toBeNull();
    expect(decimalToCents('-1')).toBeNull();
  });

  it('references are typeable and receipts are numbered VF-RCT-2026-000001 in Vietnam time', () => {
    expect(createPaymentReference()).toMatch(/^VF-[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(documentNumber('RCT', 2026, 1)).toBe('VF-RCT-2026-000001');
    // 31 Dec 2026 18:00 UTC is already 1 Jan 2027 in Da Nang.
    expect(vietnamDate(Date.UTC(2026, 11, 31, 18))).toEqual({ year: 2027, date: '2027-01-01' });
  });

  it('a Vietnamese tax code (MST) is 10 digits, or 13 for a branch', () => {
    expect(normalizeTaxCode('0402339145')).toBe('0402339145');
    expect(normalizeTaxCode('0402339145-001')).toBe('0402339145-001');
    expect(normalizeTaxCode('0402339145001')).toBe('0402339145-001');
    expect(normalizeTaxCode('040233914')).toBeNull();
    expect(normalizeTaxCode('04023391450')).toBeNull();
    expect(normalizeTaxCode('MST0402339145')).toBeNull();
    expect(() => cleanVatInvoiceDetails({ companyName: 'Cty A', taxCode: '123', address: 'Da Nang', email: 'a@b.vn' })).toThrow('10 digits');
    expect(cleanVatInvoiceDetails({ companyName: ' Cty A ', taxCode: '0402339145', address: 'Da Nang', email: 'KT@B.VN' })).toEqual({ companyName: 'Cty A', taxCode: '0402339145', address: 'Da Nang', email: 'kt@b.vn' });
  });

  it('a billing profile needs a name, valid email and country', () => {
    expect(() => cleanBuyerProfile({ name: '', country: 'GB' }, 'a@b.co')).toThrow('name');
    expect(() => cleanBuyerProfile({ name: 'A', country: 'Britain' }, 'a@b.co')).toThrow('country');
    expect(cleanBuyerProfile({ name: ' A ', country: 'gb', taxId: ' X1 ' }, 'a@b.co')).toEqual({ name: 'A', email: 'a@b.co', country: 'GB', taxId: 'X1' });
  });
});

describe('billing store (D1, real SQL)', () => {
  async function paidSetup() {
    const f = billingFixture();
    await f.store.saveSetting(SETTINGS.account, WORLDFIRST, 'admin@x');
    const ws = await workspace(f.store);
    await f.service.saveProfile(ws, BUYER);
    return { ...f, ws };
  }

  it('one order per idempotency key: a double click makes one order', async () => {
    const { service, ws, store } = await paidSetup();
    const [a, b] = await Promise.all([
      service.createOrder(ws, { amountCents: 2500, method: 'worldfirst', idempotencyKey: 'click-0001' }),
      service.createOrder(ws, { amountCents: 2500, method: 'worldfirst', idempotencyKey: 'click-0001' }),
    ]);
    expect(a.order.id).toBe(b.order.id);
    expect(await store.orders(ws.id)).toHaveLength(1);
    expect(a.order.account).toMatchObject({ swiftCode: 'CMFGUS33' });
  });

  it('mark paid credits the ledger and issues one receipt, however often it runs', async () => {
    const { service, ws, store } = await paidSetup();
    const { order } = await service.createOrder(ws, { amountCents: 2500, method: 'worldfirst', idempotencyKey: 'k-00000001' });
    expect((await store.balance(ws.id)).cents).toBe(0);
    const runs = await Promise.all([1, 2, 3].map(() => service.markPaid(order.id, { by: 'admin@x', captureId: 'BANK-1' })));
    expect(runs.filter((r) => r.transitioned)).toHaveLength(1);
    await service.markPaid(order.id, { by: 'admin@x' });
    expect((await store.balance(ws.id)).cents).toBe(2500);
    expect((await store.ledger(ws.id)).filter((l) => l.kind === 'payment')).toHaveLength(1);
    expect(await store.receipts(ws.id)).toHaveLength(1);
    expect(await store.einvoices(ws.id)).toHaveLength(0);
    const receipt = (await store.receipts(ws.id))[0]!;
    expect(receipt).toMatchObject({ number: 'VF-RCT-2026-000001', mode: 'live', amountCents: 2500, totalCents: 2500, providerReference: 'BANK-1', buyer: { name: 'Ann Nguyen', country: 'GB' } });
  });

  it('receipt numbers have no gaps under concurrent payments across workspaces', async () => {
    const f = billingFixture();
    await f.store.saveSetting(SETTINGS.account, WORLDFIRST, 'admin@x');
    const orders = [];
    for (let i = 0; i < 12; i++) {
      const ws = await workspace(f.store);
      await f.service.saveProfile(ws, { ...BUYER, country: i % 3 ? 'GB' : 'VN' });
      orders.push((await f.service.createOrder(ws, { amountCents: 1000 + i, method: 'worldfirst', idempotencyKey: `idem-${String(i).padStart(4, '0')}` })).order);
    }
    // Every order paid at once, each one twice (a double click, a replay).
    await Promise.all(orders.flatMap((o) => [f.service.markPaid(o.id, { by: 'a' }), f.service.markPaid(o.id, { by: 'b' })]));
    const rct = f.db.sqlite.prepare('SELECT seq, number FROM receipts ORDER BY seq').all() as Array<{ seq: number; number: string }>;
    expect(rct.map((r) => r.seq)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(rct[rct.length - 1]!.number).toBe('VF-RCT-2026-000012');
    expect(new Set(rct.map((r) => r.number)).size).toBe(12);
    const credits = f.db.sqlite.prepare("SELECT count(*) AS n, sum(amount_cents) AS s FROM ledger WHERE kind = 'payment'").get() as { n: number; s: number };
    expect(credits).toEqual({ n: 12, s: 12 * 1000 + 66 });
    // VAT went on top for the Vietnamese buyers; the receipt is what they paid.
    const vn = f.db.sqlite.prepare('SELECT total_cents AS paid, amount_cents AS credit FROM receipts WHERE vat_rate_bp = 1000 ORDER BY seq').all() as Array<{ paid: number; credit: number }>;
    expect(vn[0]).toEqual({ paid: 1100, credit: 1000 });
  });

  it('a new year starts again at 000001', async () => {
    const f = billingFixture();
    await f.store.saveSetting(SETTINGS.account, WORLDFIRST, 'admin@x');
    const ws = await workspace(f.store);
    await f.service.saveProfile(ws, BUYER);
    const a = (await f.service.createOrder(ws, { amountCents: 1000, method: 'worldfirst', idempotencyKey: 'year-0001' })).order;
    const b = (await f.service.createOrder(ws, { amountCents: 1000, method: 'worldfirst', idempotencyKey: 'year-0002' })).order;
    f.clock.now = Date.UTC(2026, 11, 31, 16, 59);
    await f.service.markPaid(a.id, { by: 'x' });
    f.clock.now = Date.UTC(2026, 11, 31, 17, 1); // 1 Jan 2027 00:01 in Vietnam
    await f.service.markPaid(b.id, { by: 'x' });
    expect((await f.store.receiptForOrder(a.id))!.number).toBe('VF-RCT-2026-000001');
    expect((await f.store.receiptForOrder(b.id))!.number).toBe('VF-RCT-2027-000001');
  });

  it('usage is charged in whole cents to the ledger; fractions carry over', async () => {
    const { store, ws } = await paidSetup();
    await store.addAdjustment(ws.id, 1000, 'test credit', 'test:1');
    for (let i = 0; i < 10; i++) await store.chargeUsage(ws.id, 3_000); // $0.003 each
    const ledger = await store.ledger(ws.id);
    const usage = ledger.filter((l) => l.kind === 'usage');
    expect(usage.reduce((s, l) => s + l.amountCents, 0)).toBe(-3);
    expect(usage.every((l) => Number.isInteger(l.amountCents))).toBe(true);
    const balance = await store.balance(ws.id);
    expect(balance).toEqual({ cents: 997, pendingMicros: 0, availableMicros: 9_970_000 });
    await store.chargeUsage(ws.id, 4_200);
    expect(await store.balance(ws.id)).toEqual({ cents: 997, pendingMicros: 4_200, availableMicros: 9_965_800 });
    // The balance is the ledger's sum: nothing else holds money.
    const sum = (await store.ledger(ws.id)).reduce((s, l) => s + l.amountCents, 0);
    expect(sum).toBe(997);
  });

  it('a cancelled order cannot be paid; a pending one only by its own workspace', async () => {
    const { service, store, ws } = await paidSetup();
    const other = await workspace(store);
    const { order } = await service.createOrder(ws, { amountCents: 1000, method: 'worldfirst', idempotencyKey: 'cancel-001' });
    expect(await store.cancelOrder(order.id, other.id)).toBe(false);
    expect(await store.cancelOrder(order.id, ws.id)).toBe(true);
    await expect(service.markPaid(order.id, { by: 'x' })).rejects.toThrow('cancelled');
    expect((await store.balance(ws.id)).cents).toBe(0);
  });

  it('orders need a billing profile and a configured method', async () => {
    const f = billingFixture({ paypal: () => null });
    const ws = await workspace(f.store);
    await expect(f.service.createOrder(ws, { amountCents: 1000, method: 'worldfirst', idempotencyKey: 'nope-0001' })).rejects.toThrow('billing details');
    await f.service.saveProfile(ws, BUYER);
    await expect(f.service.createOrder(ws, { amountCents: 1000, method: 'worldfirst', idempotencyKey: 'nope-0002' })).rejects.toThrow('Bank transfer is not available');
    await expect(f.service.createOrder(ws, { amountCents: 1000, method: 'paypal', idempotencyKey: 'nope-0003' })).rejects.toThrow('PayPal is not available');
    await expect(f.service.createOrder(ws, { amountCents: 1000, method: 'sepay', idempotencyKey: 'nope-0004' })).rejects.toThrow('Vietnamese bank transfer is not available');
  });

  it('deleting a workspace keeps its ledger, invoices and receipts but not its personal data', async () => {
    const { service, store, ws, db } = await paidSetup();
    const { order } = await service.createOrder(ws, { amountCents: 1000, method: 'worldfirst', idempotencyKey: 'del-00001' });
    await service.markPaid(order.id, { by: 'x' });
    await store.deleteWorkspace(ws.id);
    const row = db.sqlite.prepare('SELECT email, owner_sub, deleted_at FROM workspaces WHERE id = ?').get(ws.id) as { email: string; owner_sub: string; deleted_at: number };
    expect(row.email).toBe('');
    expect(row.owner_sub).toBe(`deleted:${ws.id}`);
    expect(row.deleted_at).toBeGreaterThan(0);
    expect(await store.profile(ws.id)).toBeNull();
    expect(await store.workspaceBySub(ws.ownerSub)).toBeNull();
    expect(await store.receipts(ws.id)).toHaveLength(1);
    expect((await store.ledger(ws.id)).length).toBeGreaterThan(0);
  });
});
