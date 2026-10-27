import { createRequire } from 'node:module';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { ZodError, z } from 'zod';
import { PaymentProposalSchema, RemedyProposalSchema } from './domain/schemas.js';
import { Gateway, GatewayError } from './gateway/gateway.js';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { InProcessAgentApi } from './mcp/agent-api.js';
import { createPaywardenMcpServer } from './mcp/server.js';
import type { Playgrounds } from './playground.js';
import { agentAttempt, runScenario } from './scenario.js';
import type { FakePayPal } from './paypal/fake.js';
import { actorName, bearer, Credentials, type AuthConfig, type Identity, type Role } from './http/auth.js';
import { RateLimiter, rateLimit } from './http/rate-limit.js';

export type { AuthConfig } from './http/auth.js';

const param = (req: Request, name: string): string => String(req.params[name] ?? '');

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
// The package's "exports" hide its browser bundle from Node's resolver, so find the package folder instead.
const AG_GRID_ENTRY = createRequire(import.meta.url).resolve('ag-grid-community');
const AG_GRID_JS = join(AG_GRID_ENTRY.slice(0, AG_GRID_ENTRY.lastIndexOf(`${sep}ag-grid-community${sep}`) + `${sep}ag-grid-community`.length), 'dist', 'ag-grid-community.min.js');

/** Locked-down headers for the HTML pages: our own scripts only, no framing, no inline script. */
const pageHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      // AG Grid's theming injects <style> elements at runtime.
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      'font-src https://fonts.gstatic.com data:',
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; '),
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
};

export interface AppOptions {
  /**
   * Only passed when running against the offline PayPal fake. Enables a dev-only
   * endpoint that stands in for the human payer clicking "Pay" in PayPal checkout.
   * With real PayPal this never exists.
   */
  fake?: FakePayPal;
  /** Fake mode only: may this instance run the built-in scenario now? Returns a reason when not. */
  scenarioGate?: () => string | undefined;
  /** Fake mode only: may the agent make one more trial purchase? Returns a reason when not. */
  attemptGate?: () => string | undefined;
  /** Enables private visitor playgrounds at POST /v1/playground and /play/:pid/... */
  playgrounds?: Playgrounds;
  /** Behind a reverse proxy (Render): use X-Forwarded-For for the client IP. */
  trustProxy?: boolean;
  /** Send Strict-Transport-Security (only behind HTTPS, e.g. in production). */
  hsts?: boolean;
  /** Per-IP limits; defaults suit one small instance. */
  limits?: { apiPerMinute?: number; webhookPerMinute?: number; authFailuresPer10Min?: number };
}

/** Headers for every response: no sniffing, no framing, no referrer leaks, HTTPS only when hosted. */
const baseHeaders =
  (hsts: boolean): RequestHandler =>
  (_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (hsts) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  };

const identityOf = (res: Response): Identity => res.locals['identity'] as Identity;

export function createApp(gateway: Gateway, auth: AuthConfig, opts: AppOptions = {}) {
  const app = express();
  app.disable('x-powered-by');
  if (opts.trustProxy) app.set('trust proxy', 1);
  app.use(baseHeaders(Boolean(opts.hsts)));

  /**
   * Two kinds of credential on purpose. An agent can ask to pay; only an owner can approve,
   * change mandates, refund or flip the kill switch, so an agent that has been talked into
   * something cannot approve its own request. Repeated bad tokens from one address are throttled.
   */
  const credentials = new Credentials(auth);
  const authFailures = new RateLimiter(opts.limits?.authFailuresPer10Min ?? 30, 10 * 60_000);
  const requireRole =
    (roles: Role[], who: string): RequestHandler =>
    (req, res, next) => {
      const ip = req.ip ?? 'unknown';
      if (authFailures.blocked(ip)) {
        res.status(429).json({ error: 'TOO_MANY_FAILED_ATTEMPTS', message: 'Too many requests with a wrong token from this address. Wait a few minutes.' });
        return;
      }
      const identity = credentials.identify(bearer(req));
      if (!identity || !roles.includes(identity.role)) {
        authFailures.hit(ip);
        res.status(401).json({ error: 'UNAUTHORIZED', message: `A valid ${who} token is required.` });
        return;
      }
      res.locals['identity'] = identity;
      next();
    };
  const agent = requireRole(['agent'], 'agent');
  const owner = requireRole(['owner'], 'owner');
  // Either credential, for read-only status such as an order the agent created.
  const anyone = requireRole(['agent', 'owner'], '');

  /** An agent token bound to one agent may only see and act on that agent's orders. */
  const visibleOrder = (res: Response, orderId: string) => {
    const order = gateway.getOrder(orderId);
    const id = identityOf(res);
    if (id.role === 'agent' && id.agentId && order.proposal.agentId !== id.agentId) {
      throw new GatewayError('ORDER_NOT_FOUND', 'No such order.', 404);
    }
    return order;
  };
  const who = (res: Response, typed: unknown) => actorName(identityOf(res), typeof typed === 'string' ? typed : undefined);

  const api = rateLimit(new RateLimiter(opts.limits?.apiPerMinute ?? 600, 60_000), 'Too many requests from this address. Slow down and try again in a minute.');
  app.use(['/v1', '/mcp', '/play'], api);

  // ── Pages: a public home page and the owner dashboard (its data needs the owner token) ──
  app.get('/', pageHeaders, (_req, res) => res.sendFile('index.html', { root: PUBLIC_DIR }));
  app.get('/dashboard', pageHeaders, (_req, res) => res.sendFile('dashboard.html', { root: PUBLIC_DIR }));
  app.get('/assets/ag-grid.js', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(AG_GRID_JS);
  });
  app.use('/assets', pageHeaders, express.static(`${PUBLIC_DIR}/assets`, { index: false, maxAge: 0 }));

  // ── Private playgrounds for visitors: each is a separate, throwaway instance ──
  if (opts.playgrounds) {
    const playgrounds = opts.playgrounds;
    app.post('/v1/playground', (req, res) => {
      const pg = playgrounds.create(req.ip ?? 'unknown');
      if (!pg) {
        res.status(429).json({ error: 'TOO_MANY_PLAYGROUNDS', message: 'Too many playgrounds from this address this hour. Try again later.' });
        return;
      }
      res.status(201).json({ id: pg.id, token: pg.ownerToken, apiBase: `/play/${pg.id}`, idleMinutes: pg.idleMinutes });
    });
    app.use('/play/:pid', playgrounds.route());
  }

  app.get('/health', (_req, res) => {
    // Reports the mode so nobody mistakes the offline fake for real PayPal sandbox traffic.
    res.json({ ok: true, paypal: opts.fake ? 'fake' : 'sandbox', ai: gateway.state().aiProvider });
  });

  // PayPal webhooks need the exact raw bytes for signature verification, so this
  // route is registered before the JSON body parser.
  const webhookLimit = rateLimit(new RateLimiter(opts.limits?.webhookPerMinute ?? 120, 60_000), 'Too many webhook calls.');
  app.post('/webhooks/paypal', webhookLimit, express.raw({ type: '*/*', limit: '1mb' }), async (req, res, next) => {
    try {
      const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
      res.json(await gateway.handleWebhook(headers, raw));
    } catch (e) {
      next(e);
    }
  });

  app.use(express.json({ limit: '256kb' }));

  // ── Agent ──
  app.post('/v1/payments/authorize', agent, async (req, res) => {
    const proposal = PaymentProposalSchema.parse(req.body);
    const bound = identityOf(res).agentId;
    if (bound && proposal.agentId !== bound) {
      res.status(403).json({ error: 'AGENT_TOKEN_MISMATCH', message: `This token belongs to agent "${bound}" and cannot ask to pay for "${proposal.agentId}".` });
      return;
    }
    const result = await gateway.authorize(proposal);
    res.status(result.status === 'denied' ? 403 : result.status === 'failed' ? 502 : 200).json(result);
  });

  // MCP front door (Streamable HTTP, stateless). The agent token is the only way in, and the
  // tools behind it are agent powers only: read the permit, browse, ask to pay, check, capture.
  // One handler per agent identity, so a bound token's tools only see that agent's permits and orders.
  const mcpHandlers = new Map<string, ReturnType<typeof toNodeHandler>>();
  const mcpFor = (agentId: string | undefined) => {
    const key = agentId ?? '*';
    let h = mcpHandlers.get(key);
    if (!h) {
      const api = new InProcessAgentApi(gateway, agentId);
      h = toNodeHandler(createMcpHandler(() => createPaywardenMcpServer(api)));
      mcpHandlers.set(key, h);
    }
    return h;
  };
  app.all('/mcp', agent, (req, res) => void mcpFor(identityOf(res).agentId)(req, res, req.body));

  // What the agent may read about its own authority and the merchants it may buy from.
  app.get('/v1/agent/permits', agent, (req, res) => {
    const asked = typeof req.query['agentId'] === 'string' ? req.query['agentId'] : undefined;
    res.json({ permits: gateway.agentPermits(identityOf(res).agentId ?? asked) });
  });

  app.get('/v1/catalog', anyone, (req, res) => {
    const merchantId = typeof req.query['merchantId'] === 'string' ? req.query['merchantId'] : undefined;
    res.json({ merchants: gateway.catalog(merchantId) });
  });

  app.get('/v1/orders/:id', anyone, (req, res) => {
    res.json(visibleOrder(res, param(req, 'id')));
  });

  app.post('/v1/orders/:id/capture', anyone, async (req, res) => {
    res.json(await gateway.capture(visibleOrder(res, param(req, 'id')).id));
  });

  // ── Owner ──
  app.post('/v1/mandates/compile', owner, async (req, res) => {
    const { text } = z.object({ text: z.string().min(3).max(2000) }).parse(req.body);
    res.json(await gateway.compileMandate(text));
  });

  app.post('/v1/mandates', owner, (req, res) => {
    const body = z.object({ draft: z.unknown(), subject: z.string().min(1), agentId: z.string().min(1) }).parse(req.body);
    res.status(201).json(gateway.activateMandate({ draft: body.draft as never, subject: body.subject, agentId: body.agentId }));
  });

  app.post('/v1/mandates/:id/revoke', owner, (req, res) => {
    const { by } = z.object({ by: z.string().min(1).max(80).optional() }).parse(req.body ?? {});
    gateway.revokeMandate(param(req, 'id'), who(res, by));
    res.json({ revoked: true });
  });

  app.post('/v1/quotes', owner, (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    res.status(201).json(gateway.approveQuote({ ...body, approvedBy: who(res, body['approvedBy']) }));
  });

  app.get('/v1/approvals', owner, (_req, res) => {
    res.json(gateway.state().pendingApprovals);
  });

  app.post('/v1/approvals/:id/resolve', owner, async (req, res) => {
    const body = z.object({ approver: z.string().min(1).max(80).optional(), approve: z.boolean() }).parse(req.body);
    res.json(await gateway.resolveApproval(param(req, 'id'), who(res, body.approver), body.approve));
  });

  app.post('/v1/kill', owner, (req, res) => {
    const body = z.object({ by: z.string().min(1).max(80).optional(), reason: z.string().max(300).default('manual') }).parse(req.body ?? {});
    gateway.kill(who(res, body.by), body.reason);
    res.json({ killSwitch: true });
  });

  app.post('/v1/resume', owner, (req, res) => {
    const { by } = z.object({ by: z.string().min(1).max(80).optional() }).parse(req.body ?? {});
    gateway.resume(who(res, by));
    res.json({ killSwitch: false });
  });

  app.post('/v1/orders/:id/fulfillment', owner, async (req, res) => {
    const body = z.object({ shipped: z.array(z.object({ sku: z.string().min(1), quantity: z.number().int().min(0) })) }).parse(req.body);
    res.json(await gateway.reconcileFulfillment(param(req, 'id'), body.shipped));
  });

  app.post('/v1/exceptions/:id/approve', owner, async (req, res) => {
    const body = z.object({ approvedBy: z.string().min(1).max(80).optional(), override: RemedyProposalSchema.optional() }).parse(req.body ?? {});
    res.json(await gateway.approveRemedy(param(req, 'id'), who(res, body.approvedBy), body.override));
  });

  app.post('/v1/refunds', owner, async (req, res) => {
    const body = z.object({ orderId: z.string().min(1), amountMinor: z.number().int().positive(), approvedBy: z.string().min(1).max(80).optional(), reason: z.string().min(1).max(300) }).parse(req.body);
    res.json(await gateway.refund({ ...body, approvedBy: who(res, body.approvedBy) }));
  });

  app.get('/v1/state', owner, (_req, res) => {
    res.json(gateway.state());
  });

  app.get('/v1/dashboard', owner, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const id = identityOf(res);
    res.json({ ...gateway.dashboard(), paypal: opts.fake ? 'fake' : 'sandbox', viewer: { name: id.name ?? null, verified: Boolean(id.name) } });
  });

  app.get('/v1/audit', owner, (_req, res) => {
    res.json({ verification: gateway.state().audit, entries: gateway.auditEntries() });
  });

  app.get('/v1/audit/verify', owner, (_req, res) => {
    res.json(gateway.state().audit);
  });

  if (opts.fake) {
    const fake = opts.fake;
    let scenarioBusy = false;
    // Offline-fake instances only: play the agent and the payer through the standard story.
    app.post('/v1/scenario', owner, async (req, res) => {
      if (scenarioBusy) {
        res.status(409).json({ error: 'SCENARIO_RUNNING', message: 'The scenario is already running.' });
        return;
      }
      const blocked = opts.scenarioGate?.();
      if (blocked) {
        res.status(429).json({ error: 'SCENARIO_LIMIT', message: blocked });
        return;
      }
      const { name } = z.object({ name: z.string().min(1).max(80).default('you') }).parse(req.body ?? {});
      scenarioBusy = true;
      try {
        res.json({ log: await runScenario(gateway, fake, name) });
      } finally {
        scenarioBusy = false;
      }
    });
    app.post('/v1/scenario/attempt', owner, async (req, res) => {
      const blocked = opts.attemptGate?.();
      if (blocked) {
        res.status(429).json({ error: 'ATTEMPT_LIMIT', message: blocked });
        return;
      }
      const { name } = z.object({ name: z.string().min(1).max(80).default('you') }).parse(req.body ?? {});
      res.json({ step: await agentAttempt(gateway, fake, name) });
    });
    app.post('/dev/fake/payer-approve/:paypalOrderId', owner, (req, res) => {
      fake.simulatePayerApproval(param(req, 'paypalOrderId'));
      res.json({ simulated: true, note: 'FAKE mode only: stands in for the human payer approving in PayPal checkout.' });
    });
  }

  // Placeholders for the PayPal redirect after the human payer finishes checkout.
  app.get('/checkout/return', (_req, res) => {
    res.type('text/plain').send('Payment approved in PayPal. You can close this tab; the order will be captured by the gateway.');
  });
  app.get('/checkout/cancel', (_req, res) => {
    res.type('text/plain').send('Checkout cancelled. Nothing was charged.');
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: 'VALIDATION_ERROR', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
      return;
    }
    if (err instanceof GatewayError) {
      res.status(err.httpStatus).json({ error: err.code, message: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : 'Unexpected error';
    // Mandate compilation failures are user-fixable (for example, a missing limit).
    const status = /per-purchase limit|No per-purchase/i.test(message) ? 422 : 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: status === 500 ? 'INTERNAL_ERROR' : 'UNPROCESSABLE', message: status === 500 ? 'Unexpected server error.' : message });
  });

  return app;
}
