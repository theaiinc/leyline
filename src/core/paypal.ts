import { secretsFor, type ProviderMode } from './provider-modes';
import { centsToDecimal, decimalToCents, type BillingOrder, type PaymentGateway } from './billing';

/**
 * PayPal Orders API v2 (USD; PayPal balance or card as a guest): create an order, the customer approves it on
 * PayPal, Valefront captures it. The webhook (PAYMENT.CAPTURE.COMPLETED) covers captures that complete later or a
 * customer who closed the tab before coming back; its signature is checked with PayPal's verify-webhook-signature.
 *
 * Sandbox or live is switched on the admin host (provider-modes.ts); each mode has its own Worker secrets:
 * PAYPAL_{SANDBOX,LIVE}_CLIENT_ID, _CLIENT_SECRET, _WEBHOOK_ID. None of them is ever logged or sent to the browser.
 */
export type PayPalEnv = 'sandbox' | 'live';

export type PayPalConfig = {
  env: PayPalEnv;
  clientId: string;
  clientSecret: string;
  webhookId: string;
  fetchImpl?: typeof fetch;
};

export type PayPalCapture = {
  /** The capture id: what makes a payment unique. */
  captureId: string;
  status: string;
  amountCents: number | null;
  currency: string;
  /** Our order id, sent as custom_id when the PayPal order was made. */
  customId: string | null;
  paypalOrderId: string | null;
};

/** PayPal for a mode, from that mode's secrets (PAYPAL_SANDBOX_* or PAYPAL_LIVE_*), or null when they're missing. */
export function paypalConfigFor(env: Record<string, string | undefined>, mode: ProviderMode, fetchImpl?: typeof fetch): PayPalConfig | null {
  const s = secretsFor(env, 'paypal', mode);
  if (!s) return null;
  return { env: mode === 'live' ? 'live' : 'sandbox', clientId: s.CLIENT_ID!, clientSecret: s.CLIENT_SECRET!, webhookId: s.WEBHOOK_ID!, ...(fetchImpl ? { fetchImpl } : {}) };
}

export class PayPalError extends Error {
  constructor(message: string, readonly status: number, readonly issue?: string) {
    super(message);
  }
}

function captureFrom(capture: Record<string, unknown> | undefined, paypalOrderId: string | null): PayPalCapture | null {
  if (!capture || typeof capture.id !== 'string') return null;
  const amount = capture.amount as { value?: string; currency_code?: string } | undefined;
  const related = (capture.supplementary_data as { related_ids?: { order_id?: string } } | undefined)?.related_ids;
  return {
    captureId: capture.id,
    status: String(capture.status ?? ''),
    amountCents: amount?.value ? decimalToCents(amount.value) : null,
    currency: String(amount?.currency_code ?? ''),
    customId: typeof capture.custom_id === 'string' ? capture.custom_id : null,
    paypalOrderId: paypalOrderId ?? related?.order_id ?? null,
  };
}

export class PayPalClient implements PaymentGateway {
  readonly method = 'paypal' as const;
  private token: { value: string; until: number } | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: PayPalConfig) {
    // Through a wrapper: Workers throws "Illegal invocation" for a bare fetch called as a method.
    this.fetchImpl = cfg.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  get env(): PayPalEnv {
    return this.cfg.env;
  }

  get base(): string {
    return this.cfg.env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.until) return this.token.value;
    const res = await this.fetchImpl(`${this.base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw new PayPalError(`PayPal sign-in failed (${res.status})`, 502);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new PayPalError('PayPal sign-in returned no token', 502);
    this.token = { value: body.access_token, until: Date.now() + Math.max(60, (body.expires_in ?? 300) - 120) * 1000 };
    return body.access_token;
  }

  private async call(path: string, init: { method: string; body?: string; requestId?: string }): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        // Idempotency on PayPal's side: the same request id returns the first result.
        ...(init.requestId ? { 'PayPal-Request-Id': init.requestId } : {}),
      },
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body };
  }

  /** A PayPal order for our order (its total, USD), and where to send the customer to approve it. */
  async createCheckout(input: { order: BillingOrder; returnUrl: string; cancelUrl: string }): Promise<{ providerOrderId: string; redirectUrl: string }> {
    const { order } = input;
    const { status, body } = await this.call('/v2/checkout/orders', {
      method: 'POST',
      requestId: `create-${order.id}`,
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: order.id,
          custom_id: order.id,
          invoice_id: order.reference,
          description: 'Valefront prepaid API credit',
          amount: {
            currency_code: 'USD',
            value: centsToDecimal(order.totalCents),
            breakdown: {
              item_total: { currency_code: 'USD', value: centsToDecimal(order.amountCents) },
              tax_total: { currency_code: 'USD', value: centsToDecimal(order.vatCents) },
            },
          },
          items: [{
            name: 'Valefront prepaid API credit',
            quantity: '1',
            category: 'DIGITAL_GOODS',
            unit_amount: { currency_code: 'USD', value: centsToDecimal(order.amountCents) },
            tax: { currency_code: 'USD', value: centsToDecimal(order.vatCents) },
          }],
        }],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: 'Valefront',
              user_action: 'PAY_NOW',
              shipping_preference: 'NO_SHIPPING',
              return_url: input.returnUrl,
              cancel_url: input.cancelUrl,
            },
          },
        },
      }),
    });
    if (status >= 300 || typeof body.id !== 'string') throw new PayPalError(`PayPal could not create the order (${status})`, 502);
    const links = (body.links ?? []) as Array<{ rel?: string; href?: string }>;
    const approve = links.find((l) => l.rel === 'payer-action') ?? links.find((l) => l.rel === 'approve');
    if (!approve?.href) throw new PayPalError('PayPal returned no approval link', 502);
    return { providerOrderId: body.id, redirectUrl: approve.href };
  }

  /** Captures an approved PayPal order; when it was already captured, returns that capture. */
  async capture(paypalOrderId: string): Promise<PayPalCapture> {
    if (!/^[A-Z0-9-]{5,64}$/i.test(paypalOrderId)) throw new PayPalError('Not a PayPal order id', 400);
    const { status, body } = await this.call(`/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, { method: 'POST', requestId: `capture-${paypalOrderId}`, body: '{}' });
    const issue = ((body.details ?? []) as Array<{ issue?: string }>)[0]?.issue;
    if (status === 422 && issue === 'ORDER_ALREADY_CAPTURED') return this.capturedOf(paypalOrderId);
    if (status === 422) throw new PayPalError(issue === 'INSTRUMENT_DECLINED' ? 'The payment was declined; try another card or PayPal account.' : `PayPal refused the capture (${issue ?? status})`, 402, issue);
    if (status >= 300) throw new PayPalError(`PayPal capture failed (${status})`, 502);
    const capture = captureFrom(firstCapture(body), paypalOrderId);
    if (!capture) throw new PayPalError('PayPal returned no capture', 502);
    return capture;
  }

  private async capturedOf(paypalOrderId: string): Promise<PayPalCapture> {
    const { status, body } = await this.call(`/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`, { method: 'GET' });
    if (status >= 300) throw new PayPalError(`PayPal order lookup failed (${status})`, 502);
    const capture = captureFrom(firstCapture(body), paypalOrderId);
    if (!capture) throw new PayPalError('PayPal order has no capture', 502);
    return capture;
  }

  /**
   * Whether a webhook really came from PayPal for our webhook: PayPal's verify-webhook-signature, given the event
   * exactly as received (the raw body, not a re-serialized copy).
   */
  async verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string): Promise<boolean> {
    const h = (name: string) => {
      const v = headers[name];
      return Array.isArray(v) ? v[0] : v;
    };
    const fields = {
      auth_algo: h('paypal-auth-algo'),
      cert_url: h('paypal-cert-url'),
      transmission_id: h('paypal-transmission-id'),
      transmission_sig: h('paypal-transmission-sig'),
      transmission_time: h('paypal-transmission-time'),
      webhook_id: this.cfg.webhookId,
    };
    if (Object.values(fields).some((v) => !v)) return false;
    try {
      JSON.parse(rawBody);
    } catch {
      return false;
    }
    const json = JSON.stringify(fields);
    const { status, body } = await this.call('/v1/notifications/verify-webhook-signature', {
      method: 'POST',
      body: `${json.slice(0, -1)},"webhook_event":${rawBody}}`,
    });
    return status === 200 && body.verification_status === 'SUCCESS';
  }
}

function firstCapture(order: Record<string, unknown>): Record<string, unknown> | undefined {
  const units = (order.purchase_units ?? []) as Array<{ payments?: { captures?: Array<Record<string, unknown>> } }>;
  return units[0]?.payments?.captures?.[0];
}

/** The capture in a PAYMENT.CAPTURE.* webhook event. */
export function captureFromEvent(event: Record<string, unknown>): PayPalCapture | null {
  return captureFrom(event.resource as Record<string, unknown> | undefined, null);
}
