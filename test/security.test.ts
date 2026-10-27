import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { createApp, type AppOptions, type AuthConfig } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { actorName, parseTokenMap } from '../src/http/auth.js';
import { buyCharger, makeEnv, MERCHANT, type Env } from './helpers.js';

const SHARED_OWNER = 'shared-owner-token-0123456789';
const SHARED_AGENT = 'shared-agent-token-0123456789';
const SAHIL = 'sahil-named-owner-token-0123456789';
const TEST_AGENT = 'bound-test-agent-token-0123456789';
const OTHER_AGENT = 'bound-other-agent-token-0123456789';

async function serve(env: Env, auth: Partial<AuthConfig> = {}, opts: AppOptions = {}) {
  const server = createApp(
    env.gateway,
    { agentToken: SHARED_AGENT, ownerToken: SHARED_OWNER, owners: { sahil: SAHIL }, agents: { 'test-agent': TEST_AGENT, 'other-agent': OTHER_AGENT }, ...auth },
    opts,
  ).listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, json: (await res.json().catch(() => ({}))) as any };
  };
  return { base, call, close: () => server.close() };
}

describe('named credentials', () => {
  it('records the approver from a named token, and marks a typed name on the shared token as unverified', async () => {
    const env = await makeEnv();
    const s = await serve(env);
    try {
      await s.call('POST', '/v1/kill', SAHIL, { by: 'Someone Else' });
      await s.call('POST', '/v1/resume', SHARED_OWNER, { by: 'Sahil' });
      const entries = (await s.call('GET', '/v1/audit', SAHIL)).json.entries as any[];
      expect(entries.find((e) => e.type === 'KILL_SWITCH_ON').data.by).toBe('sahil');
      expect(entries.find((e) => e.type === 'KILL_SWITCH_OFF').data.by).toBe('Sahil (unverified)');
      const dash = await s.call('GET', '/v1/dashboard', SAHIL);
      expect(dash.json.viewer).toEqual({ name: 'sahil', verified: true });
    } finally {
      s.close();
    }
  });

  it('holds a bound agent token to its own agent: payments, permits and orders', async () => {
    const env = await makeEnv(); // its mandate is for agent "test-agent"
    const s = await serve(env);
    try {
      const r = await buyCharger(env);
      const proposal = {
        idempotencyKey: 'sec-key-0001', mandateId: env.mandateId, agentId: 'test-agent', merchantId: MERCHANT,
        items: [{ sku: 'cable-usbc-2m', name: 'USB-C cable, 2 metres', category: 'electronics', unitPriceMinor: 900, quantity: 1 }],
        shippingMinor: 600, currency: 'USD', description: 'cable',
      };
      const stolen = await s.call('POST', '/v1/payments/authorize', OTHER_AGENT, proposal);
      expect(stolen.status).toBe(403);
      expect(stolen.json.error).toBe('AGENT_TOKEN_MISMATCH');

      expect((await s.call('GET', '/v1/agent/permits?agentId=test-agent', OTHER_AGENT)).json.permits).toEqual([]);
      expect((await s.call('GET', '/v1/agent/permits', TEST_AGENT)).json.permits).toHaveLength(1);

      expect((await s.call('GET', `/v1/orders/${r.orderId}`, OTHER_AGENT)).status).toBe(404);
      expect((await s.call('POST', `/v1/orders/${r.orderId}/capture`, OTHER_AGENT)).status).toBe(404);
      expect((await s.call('GET', `/v1/orders/${r.orderId}`, TEST_AGENT)).status).toBe(200);
    } finally {
      s.close();
    }
  });

  it('holds a bound agent token to its own agent over MCP too', async () => {
    const env = await makeEnv();
    const s = await serve(env);
    try {
      const client = new Client({ name: 'other-agent', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${s.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${OTHER_AGENT}` } } }));
      const permit = await client.callTool({ name: 'paywarden_get_spending_permit', arguments: {} });
      expect((permit.content as any[])[0].text).toMatch(/No spending permit/);
      const pay = await client.callTool({
        name: 'paywarden_request_payment',
        arguments: { permit_id: env.mandateId, merchant_id: MERCHANT, items: [{ sku: 'cable-usbc-2m', quantity: 1 }], description: 'x' },
      });
      expect(pay.isError).toBe(true);
      await client.close();
    } finally {
      s.close();
    }
  });

  it('refuses repeated tokens, short production tokens, and malformed token lists', () => {
    expect(() => loadConfig({ AGENT_API_TOKEN: 'same-token-012345678901234', OWNER_API_TOKEN: 'same-token-012345678901234' })).toThrow(/must be different/);
    expect(() => loadConfig({ AGENT_API_TOKEN: 'a-token-0123456789012345', OWNER_API_TOKEN: 'o-token-0123456789012345', OWNER_TOKENS: 'sahil=a-token-0123456789012345' })).toThrow(/must be different/);
    expect(() => loadConfig({ NODE_ENV: 'production', AGENT_API_TOKEN: 'short-a', OWNER_API_TOKEN: 'short-o' })).toThrow(/at least 24/);
    expect(() => parseTokenMap('bad name=xxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'OWNER_TOKENS')).toThrow(/not a valid name/);
    expect(() => parseTokenMap('sahil=short', 'OWNER_TOKENS')).toThrow(/too short/);
    expect(parseTokenMap('sahil=abc+/defghijklmnopqrstuvwxyz==, priya=zyxwvutsrqponmlkjihgfedcba', 'X')).toEqual({ sahil: 'abc+/defghijklmnopqrstuvwxyz==', priya: 'zyxwvutsrqponmlkjihgfedcba' });
    expect(actorName({ role: 'owner', name: 'sahil' }, 'Mallory')).toBe('sahil');
    expect(actorName({ role: 'owner' }, '')).toBe('owner (unverified)');
  });
});

describe('abuse limits and headers', () => {
  it('throttles an address after repeated wrong tokens, even if it then guesses right', async () => {
    const env = await makeEnv();
    const s = await serve(env, {}, { limits: { authFailuresPer10Min: 3 } });
    try {
      for (let i = 0; i < 4; i++) expect((await s.call('GET', '/v1/dashboard', `wrong-${i}`)).status).toBe(401);
      expect((await s.call('GET', '/v1/dashboard', SAHIL)).status).toBe(429);
    } finally {
      s.close();
    }
  });

  it('rate-limits the API per address', async () => {
    const env = await makeEnv();
    const s = await serve(env, {}, { limits: { apiPerMinute: 5 } });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) statuses.push((await s.call('GET', '/v1/catalog', SHARED_AGENT)).status);
      expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
      const limited = await s.call('GET', '/v1/catalog', SHARED_AGENT);
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBeTruthy();
    } finally {
      s.close();
    }
  });

  it('sends security headers everywhere and does not advertise the framework', async () => {
    const env = await makeEnv();
    const s = await serve(env, {}, { hsts: true });
    try {
      for (const path of ['/health', '/', '/v1/catalog']) {
        const res = await fetch(`${s.base}${path}`);
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('x-frame-options')).toBe('DENY');
        expect(res.headers.get('strict-transport-security')).toMatch(/max-age=/);
        expect(res.headers.get('x-powered-by')).toBeNull();
      }
    } finally {
      s.close();
    }
  });
});

describe('webhook hardening', () => {
  it('turns webhook spam into one audit line and a counter, and never asks PayPal about junk', async () => {
    const env = await makeEnv();
    let verifyCalls = 0;
    const real = env.fake.verifyWebhook.bind(env.fake);
    env.fake.verifyWebhook = async (input) => { verifyCalls++; return real(input); };
    for (let i = 0; i < 50; i++) await env.gateway.handleWebhook({}, JSON.stringify({ id: `SPAM-${i}`, event_type: 'PAYMENT.CAPTURE.COMPLETED' })).catch(() => undefined);
    for (let i = 0; i < 20; i++) await env.gateway.handleWebhook({}, `{"id":"x"}, "webhook_id":"attacker"`).catch(() => undefined);
    expect(env.audit.entries().filter((e) => e.type === 'WEBHOOK_REJECTED')).toHaveLength(1);
    expect(env.store.webhookRejections.total).toBe(70);
    expect(verifyCalls).toBe(50); // the 20 malformed bodies were refused before verification
  });

  it('skips an already-handled event without verifying it again', async () => {
    const env = await makeEnv();
    let verifyCalls = 0;
    const real = env.fake.verifyWebhook.bind(env.fake);
    env.fake.verifyWebhook = async (input) => { verifyCalls++; return real(input); };
    const body = JSON.stringify({ id: 'EVT-1', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: 'nope' } });
    expect(await env.gateway.handleWebhook({ 'x-fake-signature': 'valid' }, body)).toEqual({ handled: true });
    expect(await env.gateway.handleWebhook({ 'x-fake-signature': 'valid' }, body)).toEqual({ handled: false });
    expect(verifyCalls).toBe(1);
  });

  it('only trusts PayPal-hosted signing certificates', async () => {
    const { isPayPalCertUrl } = await import('../src/paypal/client.js');
    expect(isPayPalCertUrl('https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1')).toBe(true);
    expect(isPayPalCertUrl('https://api.paypal.com/v1/notifications/certs/CERT-1')).toBe(true);
    expect(isPayPalCertUrl('http://api.paypal.com/cert')).toBe(false);
    expect(isPayPalCertUrl('https://paypal.com.attacker.example/cert')).toBe(false);
    expect(isPayPalCertUrl('https://evilpaypal.com/cert')).toBe(false);
    expect(isPayPalCertUrl('not a url')).toBe(false);
  });
});
