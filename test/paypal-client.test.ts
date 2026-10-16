import { describe, expect, it } from 'vitest';
import { PayPalClient } from '../src/paypal/client.js';
import { PayPalError } from '../src/paypal/port.js';

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function stubFetch(handler: (seen: Seen) => { status?: number; json: unknown }) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const s: Seen = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    seen.push(s);
    const { status = 200, json } = s.url.endsWith('/v1/oauth2/token') ? { status: 200, json: { access_token: 'tok', expires_in: 3600 } } : handler(s);
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { seen, fetchImpl };
}

const cfg = { clientId: 'id', clientSecret: 'secret', baseUrl: 'https://api-m.sandbox.paypal.com', webhookId: 'WH-1' };

describe('PayPalClient (request shape only; real sandbox behaviour must be verified against the sandbox)', () => {
  it('authenticates with basic auth and reuses the token', async () => {
    const { seen, fetchImpl } = stubFetch(() => ({ json: { id: 'O1', status: 'PAYER_ACTION_REQUIRED', links: [] } }));
    const c = new PayPalClient({ ...cfg, fetchImpl });
    const order = { requestId: 'r1', referenceId: 'ref', currency: 'USD', description: 'd', items: [{ sku: 's', name: 'n', category: 'c', unitPriceMinor: 100, quantity: 1 }], shippingMinor: 0, taxMinor: 0, returnUrl: 'https://x/r', cancelUrl: 'https://x/c' };
    await c.createOrder(order);
    await c.createOrder({ ...order, requestId: 'r2' });
    const tokenCalls = seen.filter((s) => s.url.endsWith('/v1/oauth2/token'));
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]!.headers['Authorization']).toBe(`Basic ${Buffer.from('id:secret').toString('base64')}`);
    expect(tokenCalls[0]!.body).toBe('grant_type=client_credentials');
  });

  it('creates an order with exact amounts, a consistent breakdown and a PayPal-Request-Id', async () => {
    const { seen, fetchImpl } = stubFetch(() => ({
      json: { id: 'ORDER-1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'self', href: 'https://self' }, { rel: 'payer-action', href: 'https://pay/here' }] },
    }));
    const c = new PayPalClient({ ...cfg, fetchImpl });
    const res = await c.createOrder({
      requestId: 'idem-123',
      referenceId: 'order-uuid',
      currency: 'USD',
      description: 'Charger and cable',
      items: [
        { sku: 'charger-65w-uk', name: '65W charger', category: 'electronics', unitPriceMinor: 3400, quantity: 1 },
        { sku: 'cable', name: 'Cable', category: 'electronics', unitPriceMinor: 905, quantity: 2 },
      ],
      shippingMinor: 600,
      taxMinor: 5,
      returnUrl: 'https://app/return',
      cancelUrl: 'https://app/cancel',
    });
    expect(res).toEqual({ paypalOrderId: 'ORDER-1', status: 'PAYER_ACTION_REQUIRED', approveUrl: 'https://pay/here' });

    const call = seen.find((s) => s.url.endsWith('/v2/checkout/orders'))!;
    expect(call.method).toBe('POST');
    expect(call.headers['PayPal-Request-Id']).toBe('idem-123');
    expect(call.headers['Authorization']).toBe('Bearer tok');
    const body = JSON.parse(call.body!);
    const unit = body.purchase_units[0];
    expect(body.intent).toBe('CAPTURE');
    expect(unit.amount.value).toBe('58.15'); // 3400 + 2*905 + 600 + 5 = 5815
    expect(unit.amount.breakdown.item_total.value).toBe('52.10');
    expect(unit.amount.breakdown.shipping.value).toBe('6.00');
    expect(unit.amount.breakdown.tax_total.value).toBe('0.05');
    expect(unit.items[1]).toMatchObject({ sku: 'cable', quantity: '2', unit_amount: { currency_code: 'USD', value: '9.05' } });
    expect(body.payment_source.paypal.experience_context).toMatchObject({ return_url: 'https://app/return', cancel_url: 'https://app/cancel', user_action: 'PAY_NOW' });
  });

  it('falls back to the approve link for older responses', async () => {
    const { fetchImpl } = stubFetch(() => ({ json: { id: 'O', status: 'CREATED', links: [{ rel: 'approve', href: 'https://old/approve' }] } }));
    const res = await new PayPalClient({ ...cfg, fetchImpl }).createOrder({
      requestId: 'r', referenceId: 'x', currency: 'USD', description: 'd',
      items: [{ sku: 's', name: 'n', category: 'c', unitPriceMinor: 100, quantity: 1 }],
      shippingMinor: 0, taxMinor: 0, returnUrl: 'a', cancelUrl: 'b',
    });
    expect(res.approveUrl).toBe('https://old/approve');
  });

  it('captures and parses the capture id and amount', async () => {
    const { seen, fetchImpl } = stubFetch(() => ({
      json: { status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAP-9', amount: { value: '40.00', currency_code: 'USD' } }] } }] },
    }));
    const res = await new PayPalClient({ ...cfg, fetchImpl }).captureOrder('ORDER-1', 'order:capture');
    expect(res).toEqual({ status: 'COMPLETED', captureId: 'CAP-9', amountMinor: 4000, currency: 'USD' });
    const call = seen.find((s) => s.url.endsWith('/v2/checkout/orders/ORDER-1/capture'))!;
    expect(call.headers['PayPal-Request-Id']).toBe('order:capture');
  });

  it('refunds a capture with an exact amount and idempotency key', async () => {
    const { seen, fetchImpl } = stubFetch(() => ({ json: { id: 'REF-1', status: 'COMPLETED', amount: { value: '9.00', currency_code: 'USD' } } }));
    const res = await new PayPalClient({ ...cfg, fetchImpl }).refundCapture({ requestId: 'o:refund:1', captureId: 'CAP-9', amountMinor: 900, currency: 'USD', note: 'Cable missing' });
    expect(res).toEqual({ refundId: 'REF-1', status: 'COMPLETED', amountMinor: 900 });
    const call = seen.find((s) => s.url.endsWith('/v2/payments/captures/CAP-9/refund'))!;
    expect(call.headers['PayPal-Request-Id']).toBe('o:refund:1');
    expect(JSON.parse(call.body!)).toEqual({ amount: { currency_code: 'USD', value: '9.00' }, note_to_payer: 'Cable missing' });
  });

  it('turns an API error into a PayPalError that carries the debug id', async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 422, json: { name: 'UNPROCESSABLE_ENTITY', debug_id: 'dbg-77', details: [{ issue: 'ORDER_NOT_APPROVED' }] } }));
    const err = await new PayPalClient({ ...cfg, fetchImpl }).captureOrder('O', 'r').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect(err).toMatchObject({ status: 422, debugId: 'dbg-77' });
  });

  it('fails clearly when authentication is rejected', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: 'invalid_client' }), { status: 401 })) as unknown as typeof fetch;
    await expect(new PayPalClient({ ...cfg, fetchImpl }).captureOrder('O', 'r')).rejects.toThrow(/authentication failed/);
  });

  describe('verifyWebhook', () => {
    const headers = {
      'paypal-auth-algo': 'SHA256withRSA',
      'paypal-cert-url': 'https://api.sandbox.paypal.com/cert',
      'paypal-transmission-id': 'tid',
      'paypal-transmission-sig': 'sig',
      'paypal-transmission-time': '2026-10-20T10:00:00Z',
    };
    const raw = '{"id":"WH-EVT-1",  "event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"amount":{"value":"40.00"}}}';

    it('embeds the exact raw body (not a re-serialized copy) and accepts SUCCESS', async () => {
      const { seen, fetchImpl } = stubFetch(() => ({ json: { verification_status: 'SUCCESS' } }));
      expect(await new PayPalClient({ ...cfg, fetchImpl }).verifyWebhook({ headers, rawBody: raw })).toBe(true);
      const sent = seen.find((s) => s.url.endsWith('/v1/notifications/verify-webhook-signature'))!.body!;
      expect(sent).toContain(`"webhook_event":${raw}`); // note the double space survives
      const parsed = JSON.parse(sent);
      expect(parsed).toMatchObject({ webhook_id: 'WH-1', transmission_id: 'tid', auth_algo: 'SHA256withRSA' });
    });

    it('rejects FAILURE, missing headers and a missing webhook id without calling PayPal', async () => {
      const failing = stubFetch(() => ({ json: { verification_status: 'FAILURE' } }));
      expect(await new PayPalClient({ ...cfg, fetchImpl: failing.fetchImpl }).verifyWebhook({ headers, rawBody: raw })).toBe(false);

      const none = stubFetch(() => ({ json: {} }));
      const { 'paypal-transmission-sig': _drop, ...partial } = headers;
      expect(await new PayPalClient({ ...cfg, fetchImpl: none.fetchImpl }).verifyWebhook({ headers: partial, rawBody: raw })).toBe(false);
      expect(await new PayPalClient({ ...cfg, webhookId: undefined, fetchImpl: none.fetchImpl }).verifyWebhook({ headers, rawBody: raw })).toBe(false);
      expect(none.seen).toHaveLength(0);
    });
  });
});
