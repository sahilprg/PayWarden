import { timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { ZodError, z } from 'zod';
import { PaymentProposalSchema, RemedyProposalSchema } from './domain/schemas.js';
import { Gateway, GatewayError } from './gateway/gateway.js';
import type { FakePayPal } from './paypal/fake.js';

export interface AuthConfig {
  agentToken: string;
  ownerToken: string;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function bearer(req: Request): string {
  const h = req.header('authorization') ?? '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

/**
 * Two separate credentials on purpose. An agent can ask to pay; only the owner
 * can approve, change mandates, refund or flip the kill switch. An agent that
 * has been talked into something cannot approve its own request.
 */
const requireToken =
  (expected: string, who: string): RequestHandler =>
  (req, res, next) => {
    if (!safeEqual(bearer(req), expected)) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: `A valid ${who} token is required.` });
      return;
    }
    next();
  };

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
}

export function createApp(gateway: Gateway, auth: AuthConfig, opts: AppOptions = {}) {
  const app = express();
  const agent = requireToken(auth.agentToken, 'agent');
  const owner = requireToken(auth.ownerToken, 'owner');
  // Either credential, for read-only status such as an order the agent created.
  const anyone: RequestHandler = (req, res, next) => {
    const t = bearer(req);
    if (safeEqual(t, auth.agentToken) || safeEqual(t, auth.ownerToken)) return next();
    res.status(401).json({ error: 'UNAUTHORIZED', message: 'A valid token is required.' });
  };

  // ── Pages: a public home page and the owner dashboard (its data needs the owner token) ──
  app.get('/', pageHeaders, (_req, res) => res.sendFile('index.html', { root: PUBLIC_DIR }));
  app.get('/dashboard', pageHeaders, (_req, res) => res.sendFile('dashboard.html', { root: PUBLIC_DIR }));
  app.get('/assets/ag-grid.js', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(AG_GRID_JS);
  });
  app.use('/assets', pageHeaders, express.static(`${PUBLIC_DIR}/assets`, { index: false, maxAge: '5m' }));

  app.get('/health', (_req, res) => {
    // Reports the mode so nobody mistakes the offline fake for real PayPal sandbox traffic.
    res.json({ ok: true, paypal: opts.fake ? 'fake' : 'sandbox', ai: gateway.state().aiProvider });
  });

  // PayPal webhooks need the exact raw bytes for signature verification, so this
  // route is registered before the JSON body parser.
  app.post('/webhooks/paypal', express.raw({ type: '*/*', limit: '1mb' }), async (req, res, next) => {
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
    const result = await gateway.authorize(proposal);
    res.status(result.status === 'denied' ? 403 : result.status === 'failed' ? 502 : 200).json(result);
  });

  app.get('/v1/orders/:id', anyone, (req, res) => {
    res.json(gateway.getOrder(param(req, 'id')));
  });

  app.post('/v1/orders/:id/capture', anyone, async (req, res) => {
    res.json(await gateway.capture(param(req, 'id')));
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
    const { by } = z.object({ by: z.string().min(1) }).parse(req.body);
    gateway.revokeMandate(param(req, 'id'), by);
    res.json({ revoked: true });
  });

  app.post('/v1/quotes', owner, (req, res) => {
    res.status(201).json(gateway.approveQuote(req.body));
  });

  app.get('/v1/approvals', owner, (_req, res) => {
    res.json(gateway.state().pendingApprovals);
  });

  app.post('/v1/approvals/:id/resolve', owner, async (req, res) => {
    const body = z.object({ approver: z.string().min(1), approve: z.boolean() }).parse(req.body);
    res.json(await gateway.resolveApproval(param(req, 'id'), body.approver, body.approve));
  });

  app.post('/v1/kill', owner, (req, res) => {
    const body = z.object({ by: z.string().min(1), reason: z.string().default('manual') }).parse(req.body);
    gateway.kill(body.by, body.reason);
    res.json({ killSwitch: true });
  });

  app.post('/v1/resume', owner, (req, res) => {
    const { by } = z.object({ by: z.string().min(1) }).parse(req.body);
    gateway.resume(by);
    res.json({ killSwitch: false });
  });

  app.post('/v1/orders/:id/fulfillment', owner, async (req, res) => {
    const body = z.object({ shipped: z.array(z.object({ sku: z.string().min(1), quantity: z.number().int().min(0) })) }).parse(req.body);
    res.json(await gateway.reconcileFulfillment(param(req, 'id'), body.shipped));
  });

  app.post('/v1/exceptions/:id/approve', owner, async (req, res) => {
    const body = z.object({ approvedBy: z.string().min(1), override: RemedyProposalSchema.optional() }).parse(req.body);
    res.json(await gateway.approveRemedy(param(req, 'id'), body.approvedBy, body.override));
  });

  app.post('/v1/refunds', owner, async (req, res) => {
    const body = z.object({ orderId: z.string().min(1), amountMinor: z.number().int().positive(), approvedBy: z.string().min(1), reason: z.string().min(1) }).parse(req.body);
    res.json(await gateway.refund(body));
  });

  app.get('/v1/state', owner, (_req, res) => {
    res.json(gateway.state());
  });

  app.get('/v1/dashboard', owner, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ...gateway.dashboard(), paypal: opts.fake ? 'fake' : 'sandbox' });
  });

  app.get('/v1/audit', owner, (_req, res) => {
    res.json({ verification: gateway.state().audit, entries: gateway.auditEntries() });
  });

  app.get('/v1/audit/verify', owner, (_req, res) => {
    res.json(gateway.state().audit);
  });

  if (opts.fake) {
    const fake = opts.fake;
    app.post('/dev/fake/payer-approve/:paypalOrderId', (req, res) => {
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
