/**
   * Valefront billing domain.
   *
   * WorldFirst bank transfers are deliberately represented as pending orders.
   * No WorldFirst API is called here. The Bookkeeper adapter can implement
   * `PaymentGateway` later without changing customer-facing order semantics.
   */

  export type BillingAccount = {
    accountName: string;
    accountNumber: string;
    bankName: string;
    bankAddress?: string;
    swiftCode: string;
    currency: "USD";
  };

  export type LegalSettings = {
    companyName: string;
    taxCode: string;
    address: string;
  };

  export type BillingOrderStatus = "pending" | "paid";

  export type BillingOrder = {
    id: string;
    ownerId: string;
    amountCents: number;
    reference: string;
    account: BillingAccount;
    status: BillingOrderStatus;
    createdAt: string;
    paidAt?: string;
  };

  export type BillingLedgerEntry = {
    id: string;
    ownerId: string;
    orderId: string;
    amountCents: number;
    createdAt: string;
    kind: "credit";
  };

  export interface BillingStore {
    getWorldFirstAccount(): Promise<BillingAccount | null>;
    getLegalSettings(): Promise<LegalSettings | null>;
    getOrder(id: string): Promise<BillingOrder | null>;
    listOrders(ownerId: string): Promise<BillingOrder[]>;
    saveOrder(order: BillingOrder): Promise<void>;
    markOrderPaid(orderId: string, paidAt: string): Promise<boolean>;
    addLedgerEntry(entry: BillingLedgerEntry): Promise<void>;
    getBalanceCents(ownerId: string): Promise<number>;
  }

  export interface PaymentGateway {
    createCheckout?(input: {
      order: BillingOrder;
    }): Promise<{ checkoutId: string; redirectUrl: string }>;
  }

  export function validateCreditAmount(amountCents: number): void {
    if (!Number.isInteger(amountCents) || amountCents < 1_000) {
      throw new Error("Credit amount must be at least $10.00");
    }
  }

  export function createPaymentReference(orderId: string, now = Date.now()): string {
    return `VF-${now.toString(36).toUpperCase()}-${orderId.replace(/[^A-Z0-9]/gi, "").slice(0, 8).toUpperCase()}`;
  }

  export async function createWorldFirstOrder(
    store: BillingStore,
    input: { ownerId: string; amountCents: number; id?: string; now?: Date },
  ): Promise<BillingOrder> {
    validateCreditAmount(input.amountCents);
    const account = await store.getWorldFirstAccount();
    if (!account) {
      throw new Error("WorldFirst receiving account is not configured");
    }

    const now = input.now ?? new Date();
    const id = input.id ?? crypto.randomUUID();
    const order: BillingOrder = {
      id,
      ownerId: input.ownerId,
      amountCents: input.amountCents,
      reference: createPaymentReference(id, now.getTime()),
      account,
      status: "pending",
      createdAt: now.toISOString(),
    };
    await store.saveOrder(order);
    return order;
  }

  export async function markOrderPaid(
    store: BillingStore,
    orderId: string,
    now = new Date(),
  ): Promise<BillingOrder> {
    const order = await store.getOrder(orderId);
    if (!order) throw new Error("Billing order not found");

    const transitioned = await store.markOrderPaid(orderId, now.toISOString());
    if (transitioned) {
      await store.addLedgerEntry({
        id: crypto.randomUUID(),
        ownerId: order.ownerId,
        orderId: order.id,
        amountCents: order.amountCents,
        createdAt: now.toISOString(),
        kind: "credit",
      });
    }

    const updated = await store.getOrder(orderId);
    if (!updated) throw new Error("Billing order disappeared");
    return updated;
  }

  export async function listCustomerOrders(
    store: BillingStore,
    authenticatedOwnerId: string,
  ): Promise<BillingOrder[]> {
    return store.listOrders(authenticatedOwnerId);
  }