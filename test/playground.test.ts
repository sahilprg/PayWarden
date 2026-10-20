import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HeuristicProvider } from '../src/ai/heuristic.js';
import { createApp } from '../src/app.js';
import { Playgrounds } from '../src/playground.js';
import { makeEnv, type Env } from './helpers.js';

const AGENT = 'main-agent-token-123456';
const OWNER = 'main-owner-token-123456';

let env: Env;
let base = '';
let clock = { t: 1_000_000 };
let playgrounds: Playgrounds;
let server: ReturnType<ReturnType<typeof createApp>['listen']>;

beforeAll(async () => {
  env = await makeEnv();
  playgrounds = new Playgrounds(new HeuristicProvider(), { perIpPerHour: 4, scenarioRunsEach: 1, idleMs: 60_000 }, () => clock.t);
  server = createApp(env.gateway, { agentToken: AGENT, ownerToken: OWNER }, { playgrounds }).listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
}

describe('private playgrounds', () => {
  it('gives each visitor an isolated instance that the scenario fills, and the visitor can act on it', async () => {
    const before = (await call('GET', '/v1/dashboard', OWNER)).json.decisions.length;
    const pg = await call('POST', '/v1/playground');
    expect(pg.status).toBe(201);
    const { apiBase, token } = pg.json;

    // The playground token is useless on the real instance, and the main token on the playground.
    expect((await call('GET', '/v1/dashboard', token)).status).toBe(401);
    expect((await call('GET', `${apiBase}/v1/dashboard`, OWNER)).status).toBe(401);

    const empty = await call('GET', `${apiBase}/v1/dashboard`, token);
    expect(empty.json).toMatchObject({ paypal: 'fake', decisions: [] });

    const run = await call('POST', `${apiBase}/v1/scenario`, token, { name: 'Judge' });
    expect(run.status).toBe(200);
    expect(run.json.log.map((s: any) => s.tone)).toEqual(['info', 'allow', 'deny', 'deny', 'ask', 'ask']);
    expect(run.json.log[2].codes).toEqual(expect.arrayContaining(['CATEGORY_DENIED', 'INJECTION_SUSPECTED']));

    const d = (await call('GET', `${apiBase}/v1/dashboard`, token)).json;
    expect(d.counts).toMatchObject({ allowed: 1, needsApproval: 1, denied: 2, capturedMinor: 4900 });
    expect(d.pendingApprovals).toHaveLength(1);
    expect(d.openExceptions).toHaveLength(1);

    // Approve the waiting payment, play the payer, capture, and approve the refund.
    const approved = await call('POST', `${apiBase}/v1/approvals/${d.pendingApprovals[0].id}/resolve`, token, { approver: 'Judge', approve: true });
    expect(approved.json.status).toBe('order_created');
    expect((await call('POST', `${apiBase}/dev/fake/payer-approve/${approved.json.paypalOrderId}`)).status).toBe(200);
    expect((await call('POST', `${apiBase}/v1/orders/${approved.json.orderId}/capture`, token)).json.status).toBe('captured');
    const refund = await call('POST', `${apiBase}/v1/exceptions/${d.openExceptions[0].id}/approve`, token, { approvedBy: 'Judge' });
    expect(refund.status).toBe(200);

    // A trial purchase goes through; once the agent is frozen, the same purchase is refused.
    const ok = await call('POST', `${apiBase}/v1/scenario/attempt`, token, {});
    expect(ok.json.step.tone).toBe('allow');
    expect((await call('POST', `${apiBase}/v1/kill`, token, { by: 'Judge' })).status).toBe(200);
    const frozen = await call('POST', `${apiBase}/v1/scenario/attempt`, token, {});
    expect(frozen.json.step).toMatchObject({ tone: 'deny' });
    expect(frozen.json.step.codes).toContain('KILL_SWITCH');

    // The real instance did not change.
    expect((await call('GET', '/v1/dashboard', OWNER)).json.decisions.length).toBe(before);
  });

  it('limits scenario runs per playground and new playgrounds per address', async () => {
    const pg = (await call('POST', '/v1/playground')).json;
    expect((await call('POST', `${pg.apiBase}/v1/scenario`, pg.token, {})).status).toBe(200);
    const again = await call('POST', `${pg.apiBase}/v1/scenario`, pg.token, {});
    expect(again.status).toBe(429);
    expect(again.json.message).toMatch(/Start a new playground/);

    // perIpPerHour is 4: two made above, so two more succeed and the next is refused.
    expect((await call('POST', '/v1/playground')).status).toBe(201);
    expect((await call('POST', '/v1/playground')).status).toBe(201);
    expect((await call('POST', '/v1/playground')).status).toBe(429);
  });

  it('expires idle playgrounds', async () => {
    clock.t += 2 * 3_600_000; // past the per-IP window as well
    const pg = (await call('POST', '/v1/playground')).json;
    expect((await call('GET', `${pg.apiBase}/v1/dashboard`, pg.token)).status).toBe(200);
    clock.t += 61_000;
    const gone = await call('GET', `${pg.apiBase}/v1/dashboard`, pg.token);
    expect(gone.status).toBe(404);
    expect(gone.json.error).toBe('PLAYGROUND_GONE');
  });

  it('does not offer the scenario on an instance that talks to real PayPal', async () => {
    expect((await call('POST', '/v1/scenario', OWNER, {})).status).toBe(404);
  });
});
