import { decimalToMinor, minorToDecimal } from '../util/money.js';
import {
  PayPalError,
  type CaptureResult,
  type CreateOrderInput,
  type CreateOrderResult,
  type PayPalPort,
  type RefundInput,
  type RefundResult,
  type WebhookVerifyInput,
} from './port.js';

export interface PayPalClientConfig {
  clientId: string;
  clientSecret: string;
  /** e.g. https://api-m.sandbox.paypal.com */
  baseUrl: string;
  webhookId?: string;
  fetchImpl?: typeof fetch;
}

interface AmountJson {
  value?: string;
  currency_code?: string;
}

/**
 * Thin client over the PayPal REST APIs the project uses:
 * Orders v2 (create, capture), Payments v2 (refund) and webhook verification.
 * Every money-moving call carries a PayPal-Request-Id for idempotency.
 */
export class PayPalClient implements PayPalPort {
  private token?: { value: string; expiresAt: number };
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: PayPalClientConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64');
    const res = await this.fetchImpl(`${this.cfg.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const json = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
    if (!res.ok || !json.access_token) throw new PayPalError('PayPal authentication failed', res.status);
    this.token = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 300) * 1000 };
    return this.token.value;
  }

  private async request<T>(method: string, path: string, body?: unknown, requestId?: string): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.accessToken()}`,
      'Content-Type': 'application/json',
    };
    if (requestId) headers['PayPal-Request-Id'] = requestId;
    const res = await this.fetchImpl(`${this.cfg.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const details = Array.isArray(json['details']) ? (json['details'] as Array<Record<string, unknown>>) : [];
      const issues = details
        .map((d) => [d['issue'], d['description']].filter((x) => typeof x === 'string').join(': '))
        .filter(Boolean)
        .join('; ');
      const debugId = typeof json['debug_id'] === 'string' ? ` (debug_id ${json['debug_id']})` : '';
      throw new PayPalError(
        `PayPal ${method} ${path} failed: ${String(json['name'] ?? res.status)}${issues ? ` [${issues}]` : ''}${debugId}`,
        res.status,
        typeof json['debug_id'] === 'string' ? json['debug_id'] : undefined,
        json['details'],
      );
    }
    return json as T;
  }

  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    const itemTotal = input.items.reduce((s, i) => s + i.unitPriceMinor * i.quantity, 0);
    const money = (minor: number) => ({ currency_code: input.currency, value: minorToDecimal(minor) });
    const body = {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: input.referenceId,
          description: input.description.slice(0, 127),
          amount: {
            ...money(itemTotal + input.shippingMinor + input.taxMinor),
            breakdown: {
              item_total: money(itemTotal),
              shipping: money(input.shippingMinor),
              tax_total: money(input.taxMinor),
            },
          },
          items: input.items.map((i) => ({
            name: i.name.slice(0, 127),
            sku: i.sku.slice(0, 127),
            category: 'PHYSICAL_GOODS',
            quantity: String(i.quantity),
            unit_amount: money(i.unitPriceMinor),
          })),
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            return_url: input.returnUrl,
            cancel_url: input.cancelUrl,
            user_action: 'PAY_NOW',
          },
        },
      },
    };
    const res = await this.request<{ id: string; status: string; links?: { rel: string; href: string }[] }>(
      'POST',
      '/v2/checkout/orders',
      body,
      input.requestId,
    );
    const link = res.links?.find((l) => l.rel === 'payer-action') ?? res.links?.find((l) => l.rel === 'approve');
    return { paypalOrderId: res.id, status: res.status, approveUrl: link?.href };
  }

  async captureOrder(paypalOrderId: string, requestId: string): Promise<CaptureResult> {
    const res = await this.request<{
      status: string;
      purchase_units?: { payments?: { captures?: { id: string; amount?: AmountJson }[] } }[];
    }>('POST', `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {}, requestId);
    const cap = res.purchase_units?.[0]?.payments?.captures?.[0];
    return {
      status: res.status,
      captureId: cap?.id,
      amountMinor: cap?.amount?.value ? decimalToMinor(cap.amount.value) : undefined,
      currency: cap?.amount?.currency_code,
    };
  }

  async refundCapture(input: RefundInput): Promise<RefundResult> {
    const res = await this.request<{ id: string; status: string; amount?: AmountJson }>(
      'POST',
      `/v2/payments/captures/${encodeURIComponent(input.captureId)}/refund`,
      {
        amount: { currency_code: input.currency, value: minorToDecimal(input.amountMinor) },
        note_to_payer: input.note?.slice(0, 255),
      },
      input.requestId,
    );
    return {
      refundId: res.id,
      status: res.status,
      amountMinor: res.amount?.value ? decimalToMinor(res.amount.value) : input.amountMinor,
    };
  }

  async verifyWebhook({ headers, rawBody }: WebhookVerifyInput): Promise<boolean> {
    if (!this.cfg.webhookId) return false;
    const h = (k: string) => headers[k] ?? headers[k.toLowerCase()];
    const parts = {
      auth_algo: h('paypal-auth-algo'),
      cert_url: h('paypal-cert-url'),
      transmission_id: h('paypal-transmission-id'),
      transmission_sig: h('paypal-transmission-sig'),
      transmission_time: h('paypal-transmission-time'),
    };
    if (Object.values(parts).some((v) => !v)) return false;
    // PayPal signs with a certificate it hosts itself; refuse anything else before asking PayPal.
    if (!isPayPalCertUrl(parts.cert_url!)) return false;
    // PayPal verifies against the exact bytes it sent, so embed the raw body
    // instead of re-serializing parsed JSON.
    const body = `{"auth_algo":${JSON.stringify(parts.auth_algo)},"cert_url":${JSON.stringify(parts.cert_url)},"transmission_id":${JSON.stringify(parts.transmission_id)},"transmission_sig":${JSON.stringify(parts.transmission_sig)},"transmission_time":${JSON.stringify(parts.transmission_time)},"webhook_id":${JSON.stringify(this.cfg.webhookId)},"webhook_event":${rawBody}}`;
    const res = await this.fetchImpl(`${this.cfg.baseUrl}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json' },
      body,
    });
    const json = (await res.json().catch(() => ({}))) as { verification_status?: string };
    return res.ok && json.verification_status === 'SUCCESS';
  }
}

/** True for an https URL on paypal.com (where PayPal hosts its webhook signing certificates). */
export function isPayPalCertUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && (u.hostname === 'paypal.com' || u.hostname.endsWith('.paypal.com'));
  } catch {
    return false;
  }
}
