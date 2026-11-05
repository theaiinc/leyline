import { readFileSync } from 'fs';
import { join } from 'path';
import { BillingService, type BillingEmail, type BillingServiceOptions } from '../../src/core/billing-service';
import { D1BillingStore, type WorkspaceRecord } from '../../src/core/billing-store';
import type { DocumentFonts } from '../../src/core/billing-documents';
import { sqliteD1 } from './sqlite-d1';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse/lib/pdf-parse.js') as (b: Buffer) => Promise<{ text: string }>;

const fontDir = join(__dirname, '../../src/assets/fonts');
export const fonts: DocumentFonts = { regular: readFileSync(join(fontDir, 'DejaVuSans.ttf')), bold: readFileSync(join(fontDir, 'DejaVuSans-Bold.ttf')) };

export async function pdfText(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  return (await pdfParse(Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes))).text;
}

export const FREE = { tokens: 1_000_000, expiresAfterDays: 30, models: ['seed-2-0-lite-260428'], tokensPerDay: 50_000, globalTokensPerDay: 10_000_000 };

export function billingFixture(over: Partial<BillingServiceOptions> = {}, clock = { now: Date.UTC(2026, 10, 7, 3) }) {
  const db = sqliteD1();
  const store = new D1BillingStore(db, () => clock.now);
  const emails: BillingEmail[] = [];
  const service = new BillingService({
    store,
    fonts: async () => fonts,
    dashboardUrl: 'https://dash.valefront.com',
    free: FREE,
    sendEmail: async (m) => { emails.push(m); },
    billingFrom: 'Valefront Billing <billing@valefront.com>',
    now: () => clock.now,
    ...over,
  });
  return { db, store, service, emails, clock };
}

let n = 0;
export async function workspace(store: D1BillingStore, opts: { email?: string; grant?: boolean; at?: number } = {}): Promise<WorkspaceRecord> {
  n++;
  const at = opts.at ?? Date.UTC(2026, 10, 7);
  const ws: WorkspaceRecord = { id: `ws_test${n}`, ownerSub: `sub-${n}`, email: opts.email ?? `user${n}@example.com`, emailHash: `eh${n}`, termsVersion: '2026-11-03', termsAcceptedAt: at, createdAt: at };
  await store.createWorkspace(ws, opts.grant === false ? null : { emailHash: `eh${n}`, subHash: `sh${n}`, tokens: 1_000_000, expiresAt: at + 30 * 86_400_000 }, { type: 'workspace.signup', ipHash: 'ip' });
  return ws;
}

export const BUYER = { name: 'Ann Nguyen', email: 'ann@example.com', company: 'Acme Ltd', taxId: 'GB123456789', address: '1 High St, London', country: 'GB' };
export const WORLDFIRST = { accountName: 'THE AI TECHNOLOGY COMPANY LIMITED', accountNumber: '8881234567', bankName: 'Community Federal Savings Bank', swiftCode: 'CMFGUS33', routingNumber: '026073150', currency: 'USD' as const };
