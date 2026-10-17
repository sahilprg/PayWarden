import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { claim, makeEnv, MERCHANT, NL, type Env } from './helpers.js';

const AGENT = 'agent-secret';
const OWNER = 'owner-secret';

let env: Env;
let base = '';
let server: ReturnType<ReturnType<typeof createApp>['listen']>;

beforeAll(async () => {
  env = await makeEnv();
  server = createApp(env.gateway, { agentToken: AGENT, ownerToken: OWNER }).listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

async function call(method: string, path: string, token?: string, body?: unknown, extra: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

describe('access control', () => {
  it('serves health without credentials', async () => {
    expect((await call('GET', '/health')).status).toBe(200);
  });

  it('requires the agent token to ask for a payment, and the owner token does not substitute', async () => {
    expect((await call('POST', '/v1/payments/authorize', undefined, {})).status).toBe(401);
    expect((await call('POST', '/v1/payments/authorize', OWNER, {})).status).toBe(401);
    expect((await call('POST', '/v1/payments/authorize', 'wrong', {})).status).toBe(401);
  });

  it('keeps every owner action out of the agent\'s reach', async () => {
    const attempts: [string, string, unknown][] = [
      ['POST', '/v1/kill', { by: 'agent' }],
      ['POST', '/v1/resume', { by: 'agent' }],
      ['POST', '/v1/approvals/any/resolve', { approver: 'agent', approve: true }],
      ['POST', '/v1/refunds', { orderId: 'o', amountMinor: 100, approvedBy: 'agent', reason: 'x' }],
      ['POST', '/v1/quotes', {}],
      ['POST', '/v1/mandates', {}],
      ['POST', '/v1/mandates/compile', { text: 'x' }],
      ['POST', '/v1/exceptions/any/approve', { approvedBy: 'agent' }],
      ['POST', '/v1/orders/any/fulfillment', { shipped: [] }],
      ['GET', '/v1/state', undefined],
      ['GET', '/v1/audit', undefined],
    ];
    for (const [m, p, b] of attempts) {
      const r = await call(m, p, AGENT, b);
      expect(r.status, `${m} ${p}`).toBe(401);
    }
  });
});

describe('end-to-end over HTTP', () => {
  it('compiles, activates, quotes, pays, freezes and audits', async () => {
    const compiled = await call('POST', '/v1/mandates/compile', OWNER, { text: NL });
    expect(compiled.status).toBe(200);
    expect(compiled.json.summary.join(' ')).toContain('USD 60.00');

    const mandate = await call('POST', '/v1/mandates', OWNER, { draft: compiled.json.draft, subject: 'jane', agentId: 'http-agent' });
    expect(mandate.status).toBe(201);
    const mandateId = mandate.json.body.id as string;

    const quote = await call('POST', '/v1/quotes', OWNER, {
      mandateId,
      merchantId: MERCHANT,
      items: [{ sku: 'charger-65w-uk', quantity: 1 }],
      maxTotalMinor: 5000,
      approvedBy: 'jane',
    });
    expect(quote.status).toBe(201);

    const proposal = (quoteId: string) => ({
      idempotencyKey: `http-key-${quoteId}`,
      mandateId,
      agentId: 'http-agent',
      merchantId: MERCHANT,
      items: [claim(env, 'charger-65w-uk')],
      shippingMinor: 600,
      currency: 'USD',
      description: 'Charger',
      quoteId,
    });

    const paid = await call('POST', '/v1/payments/authorize', AGENT, proposal(quote.json.id));
    expect(paid.status).toBe(200);
    expect(paid.json.status).toBe('order_created');
    expect(paid.json.approveUrl).toBeTruthy();

    expect((await call('GET', `/v1/orders/${paid.json.orderId}`, AGENT)).json.status).toBe('created');

    await call('POST', '/v1/kill', OWNER, { by: 'jane', reason: 'test' });
    const quote2 = await call('POST', '/v1/quotes', OWNER, {
      mandateId,
      merchantId: MERCHANT,
      items: [{ sku: 'charger-65w-uk', quantity: 1 }],
      maxTotalMinor: 5000,
      approvedBy: 'jane',
    });
    const blocked = await call('POST', '/v1/payments/authorize', AGENT, proposal(quote2.json.id));
    expect(blocked.status).toBe(403);
    expect(blocked.json.decision.reasons.map((r: { code: string }) => r.code)).toContain('KILL_SWITCH');
    await call('POST', '/v1/resume', OWNER, { by: 'jane' });

    const audit = await call('GET', '/v1/audit/verify', OWNER);
    expect(audit.json).toMatchObject({ ok: true });
    expect((await call('GET', '/v1/state', OWNER)).json.killSwitch).toBe(false);
  });
});

describe('error handling', () => {
  it('returns a readable 400 for a malformed payment request', async () => {
    const r = await call('POST', '/v1/payments/authorize', AGENT, { idempotencyKey: 'short' });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('VALIDATION_ERROR');
    expect(r.json.issues.length).toBeGreaterThan(0);
  });

  it('rejects malformed JSON without crashing', async () => {
    const r = await call('POST', '/v1/payments/authorize', AGENT, '{not json');
    expect([400, 500]).toContain(r.status);
    expect((await call('GET', '/health')).status).toBe(200);
  });

  it('asks for a limit instead of guessing one', async () => {
    const r = await call('POST', '/v1/mandates/compile', OWNER, { text: 'buy me something nice please' });
    expect(r.status).toBe(422);
    expect(r.json.message).toMatch(/per-purchase limit/);
  });

  it('returns 404 for an unknown order and for an unknown approval', async () => {
    expect((await call('GET', '/v1/orders/nope', AGENT)).status).toBe(404);
    expect((await call('POST', '/v1/approvals/nope/resolve', OWNER, { approver: 'jane', approve: true })).status).toBe(404);
  });
});

describe('fake-mode payer hook', () => {
  it('does not exist unless the app was started against the offline fake', async () => {
    expect((await call('POST', '/dev/fake/payer-approve/FAKE-ORDER-1')).status).toBe(404);
  });

  it('lets a fake-mode app stand in for the human payer, so capture works end to end', async () => {
    const local = await makeEnv();
    const s = createApp(local.gateway, { agentToken: AGENT, ownerToken: OWNER }, { fake: local.fake }).listen(0);
    await once(s, 'listening');
    const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    try {
      const { buyCharger } = await import('./helpers.js');
      const r = await buyCharger(local);
      const cap = (token: string) => fetch(`${url}/v1/orders/${r.orderId}/capture`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
      expect((await cap(AGENT)).status).toBe(502); // payer has not approved yet
      expect((await fetch(`${url}/dev/fake/payer-approve/${r.paypalOrderId}`, { method: 'POST' })).status).toBe(200);
      expect((await cap(AGENT)).status).toBe(200);
    } finally {
      s.close();
    }
  });
});

describe('webhook endpoint', () => {
  it('rejects an unverifiable delivery and accepts a verified one using the raw body', async () => {
    const body = JSON.stringify({ id: 'HTTP-EVT-1', event_type: 'SOMETHING.ELSE', resource: {} });
    expect((await call('POST', '/webhooks/paypal', undefined, body)).status).toBe(401);
    const ok = await call('POST', '/webhooks/paypal', undefined, body, { 'x-fake-signature': 'valid' });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ handled: true });
  });
});

describe('owner console and pages', () => {
  it('serves the home page and console shell publicly, with a strict content security policy', async () => {
    for (const path of ['/', '/dashboard']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/html/);
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    }
    const grid = await fetch(`${base}/assets/ag-grid.js`);
    expect(grid.status).toBe(200);
    expect((await grid.text()).length).toBeGreaterThan(100_000);
    expect((await fetch(`${base}/assets/dashboard.js`)).status).toBe(200);
  });

  it('gives console data only to the owner, never to the agent', async () => {
    expect((await call('GET', '/v1/dashboard')).status).toBe(401);
    expect((await call('GET', '/v1/dashboard', AGENT)).status).toBe(401);
    const res = await call('GET', '/v1/dashboard', OWNER);
    expect(res.status).toBe(200);
    expect(res.json.paypal).toBe('sandbox');
    expect(res.json.mandates[0]).toMatchObject({ status: 'active', signatureValid: true });
    expect(res.json.mandates[0].summary[0]).toContain('USD 60.00');
    expect(res.json.audit.ok).toBe(true);
  });

  it('lists every decision with its reasons, including early refusals such as a tampered permit', async () => {
    const e = await makeEnv();
    const app = createApp(e.gateway, { agentToken: AGENT, ownerToken: OWNER }).listen(0);
    await once(app, 'listening');
    const url = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    try {
      const q = e.gateway.approveQuote({ mandateId: e.mandateId, merchantId: MERCHANT, items: [{ sku: 'charger-65w-uk', quantity: 1 }], maxTotalMinor: 5000, approvedBy: 'owner' });
      const pay = (key: string, items: ReturnType<typeof claim>[]) =>
        e.gateway.authorize({ idempotencyKey: key, mandateId: e.mandateId, agentId: 'test-agent', merchantId: MERCHANT, items, shippingMinor: 600, taxMinor: 0, currency: 'USD', description: 'x', quoteId: q.id });
      await pay('k-ok', [claim(e, 'charger-65w-uk')]);
      await pay('k-gift', [claim(e, 'charger-65w-uk'), claim(e, 'giftcard-200')]);
      e.store.mandates.get(e.mandateId)!.body.perPurchaseLimitMinor = 999_999; // tamper after signing
      await pay('k-tampered', [claim(e, 'charger-65w-uk')]);
      const res = await fetch(`${url}/v1/dashboard`, { headers: { authorization: `Bearer ${OWNER}` } });
      const d = (await res.json()) as any;
      expect(d.decisions.map((x: any) => x.verdict)).toEqual(['deny', 'deny', 'allow']);
      expect(d.decisions[0].reasons.map((r: any) => r.code)).toContain('MANDATE_INVALID_SIGNATURE');
      expect(d.decisions[0]).toMatchObject({ mandateId: e.mandateId, merchantId: MERCHANT });
      expect(d.decisions[1].reasons.map((r: any) => r.code)).toContain('CATEGORY_DENIED');
      expect(d.counts).toMatchObject({ allowed: 1, denied: 2 });
      expect(d.mandates[0]).toMatchObject({ status: 'invalid', signatureValid: false, spentInPeriodMinor: 4000 });
    } finally {
      app.close();
    }
  });
});
