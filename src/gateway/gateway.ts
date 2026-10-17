import { createHash, randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import type { AIProvider } from '../ai/provider.js';
import { heuristicInjectionScan } from '../ai/injection.js';
import type { AuditLog } from '../audit/chain.js';
import type { CatalogPort } from '../catalog/catalog.js';
import {
  DraftMandateSchema,
  QuoteInputSchema,
  type DraftMandate,
  type MandateBody,
  type PaymentProposal,
  type RemedyProposal,
  type SignedMandate,
} from '../domain/schemas.js';
import type {
  ApprovalRecord,
  AuthorizationResult,
  Decision,
  ExceptionRecord,
  FulfillmentDiff,
  OrderRecord,
  Quote,
  Reason,
} from '../domain/types.js';
import type { MandateSigner } from '../mandate/sign.js';
import { summarizeMandate } from '../mandate/summary.js';
import { PayPalError, type PayPalPort } from '../paypal/port.js';
import { evaluatePolicy, tighten } from '../policy/engine.js';
import type { Store } from '../store/store.js';
import { canonicalJson } from '../util/canonical.js';
import { decimalToMinor, formatMoney } from '../util/money.js';

export class GatewayError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 400,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

export interface GatewayDeps {
  store: Store;
  audit: AuditLog;
  signer: MandateSigner;
  paypal: PayPalPort;
  catalog: CatalogPort;
  ai: AIProvider;
  now: () => Date;
  returnUrl: string;
  cancelUrl: string;
  /** Merchant refund/exchange policy text handed to the AI when it proposes a remedy. */
  merchantPolicyText?: string;
}

const hashOf = (v: unknown) => createHash('sha256').update(canonicalJson(v)).digest('hex');

/**
 * The orchestration layer between an AI agent and PayPal.
 *
 * Invariants:
 *  1. Only plain code decides. The AI can propose or tighten, never loosen.
 *  2. Agent claims (price, category, shipping) are replaced by catalogue truth.
 *  3. The agent never completes PayPal checkout; the human payer does.
 *  4. Authority is re-checked at every money-moving step, not just the first.
 *  5. Every decision and money movement lands in the hash-chained audit log.
 */
export class Gateway {
  private inflight = new Map<string, { hash: string; promise: Promise<AuthorizationResult> }>();

  constructor(private readonly d: GatewayDeps) {}

  // ───────────────────────── Mandates & quotes (owner actions) ─────────────────────────

  async compileMandate(naturalLanguage: string): Promise<{ draft: DraftMandate; summary: string[] }> {
    let draft: DraftMandate;
    try {
      draft = await this.d.ai.compileMandate(naturalLanguage);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // A missing limit is the person's to fix; everything else is the AI failing (network,
      // key, quota, or malformed output). Either way nothing is created: fail closed.
      if (/per-purchase limit/i.test(message)) throw e;
      const detail = e instanceof ZodError ? 'the model returned a mandate that failed validation' : message;
      this.d.audit.append('MANDATE_COMPILE_FAILED', { provider: this.d.ai.name, detail });
      throw new GatewayError('AI_UNAVAILABLE', `The AI could not compile the mandate (${detail}). Nothing was created.`, 502);
    }
    const summary = summarizeMandate(draft);
    this.d.audit.append('MANDATE_COMPILED', { provider: this.d.ai.name, naturalLanguage, draft });
    return { draft, summary };
  }

  activateMandate(input: { draft: DraftMandate; subject: string; agentId: string }): SignedMandate {
    const draft = DraftMandateSchema.parse(input.draft);
    const now = this.d.now();
    const body: MandateBody = {
      id: randomUUID(),
      version: 1,
      subject: input.subject,
      agentId: input.agentId,
      task: draft.task,
      currency: draft.currency,
      perPurchaseLimitMinor: draft.perPurchaseLimitMinor,
      periodLimitMinor: draft.periodLimitMinor,
      periodDays: draft.periodDays,
      approvalThresholdMinor: draft.approvalThresholdMinor,
      allowedMerchants: draft.allowedMerchants,
      deniedCategories: draft.deniedCategories,
      requireQuote: draft.requireQuote,
      notBefore: now.toISOString(),
      expiresAt: new Date(now.getTime() + draft.expiresInHours * 3_600_000).toISOString(),
      createdAt: now.toISOString(),
    };
    const signed = this.d.signer.sign(body);
    this.d.store.mandates.set(body.id, signed);
    this.d.audit.append('MANDATE_ACTIVATED', { mandateId: body.id, subject: body.subject, agentId: body.agentId, keyId: signed.keyId });
    return signed;
  }

  approveQuote(raw: unknown): Quote {
    const input = QuoteInputSchema.parse(raw);
    const mandate = this.d.store.mandates.get(input.mandateId);
    if (!mandate) throw new GatewayError('MANDATE_NOT_FOUND', 'No such mandate.', 404);
    if (this.d.store.revoked.has(input.mandateId)) throw new GatewayError('MANDATE_REVOKED', 'Mandate is revoked.', 409);
    for (const i of input.items) {
      if (!this.d.catalog.lookup(input.merchantId, i.sku)) {
        throw new GatewayError('UNKNOWN_SKU', `SKU ${i.sku} is not in ${input.merchantId}'s catalogue.`, 422);
      }
    }
    const quote: Quote = { id: randomUUID(), createdAt: this.d.now().toISOString(), ...input };
    this.d.store.quotes.set(quote.id, quote);
    this.d.audit.append('QUOTE_APPROVED', quote);
    return quote;
  }

  revokeMandate(mandateId: string, by: string): void {
    if (!this.d.store.mandates.has(mandateId)) throw new GatewayError('MANDATE_NOT_FOUND', 'No such mandate.', 404);
    this.d.store.revoked.add(mandateId);
    this.d.audit.append('MANDATE_REVOKED', { mandateId, by });
  }

  kill(by: string, reason: string): void {
    this.d.store.killSwitch = true;
    this.d.audit.append('KILL_SWITCH_ON', { by, reason });
  }

  resume(by: string): void {
    this.d.store.killSwitch = false;
    this.d.audit.append('KILL_SWITCH_OFF', { by });
  }

  // ───────────────────────── Authorization (agent action) ─────────────────────────

  authorize(proposal: PaymentProposal): Promise<AuthorizationResult> {
    const key = proposal.idempotencyKey;
    const hash = hashOf(proposal);

    const running = this.d.store.decisions.get(key) ? undefined : this.inflight.get(key);
    if (running) {
      if (running.hash !== hash) return Promise.resolve(this.keyReuse(proposal));
      return running.promise.then((r) => ({ ...r, replayed: true }));
    }

    const prior = this.d.store.decisions.get(key);
    if (prior) {
      if (prior.proposalHash !== hash) return Promise.resolve(this.keyReuse(proposal));
      this.d.audit.append('AUTHORIZE_REPLAY', { idempotencyKey: key });
      return Promise.resolve({ ...prior.result, replayed: true });
    }

    const promise = this.authorizeFresh(proposal, hash).finally(() => this.inflight.delete(key));
    this.inflight.set(key, { hash, promise });
    return promise;
  }

  private keyReuse(proposal: PaymentProposal): AuthorizationResult {
    const decision: Decision = {
      verdict: 'deny',
      totalMinor: 0,
      reasons: [{ code: 'IDEMPOTENCY_KEY_REUSE', message: 'This idempotency key was already used for a different payment.', source: 'policy' }],
    };
    this.d.audit.append('PAYMENT_DENIED', { idempotencyKey: proposal.idempotencyKey, reasons: decision.reasons });
    return { status: 'denied', decision };
  }

  private async authorizeFresh(proposal: PaymentProposal, hash: string): Promise<AuthorizationResult> {
    const { store } = this.d;
    const now = this.d.now();
    const stored = store.mandates.get(proposal.mandateId);
    if (!stored) {
      return this.settleDenied(proposal, hash, {
        verdict: 'deny',
        totalMinor: 0,
        reasons: [{ code: 'MANDATE_NOT_FOUND', message: 'No mandate with that id exists.', source: 'policy' }],
      });
    }

    const { verified, findings } = this.verifyAgainstCatalog(proposal);
    const quote = proposal.quoteId ? store.quotes.get(proposal.quoteId) : undefined;

    let decision = evaluatePolicy({
      mandate: stored,
      signatureValid: this.d.signer.verify(stored),
      revoked: store.revoked.has(stored.body.id),
      killSwitch: store.killSwitch,
      proposal: verified,
      quote,
      spentInWindowMinor: store.spentInWindow(stored.body.id, now, stored.body.periodDays),
      now,
    });
    if (findings.length > 0) decision = tighten(decision, findings, 'deny');

    // AI runs only when the deterministic layer has not already said no, and can only make things stricter.
    if (decision.verdict !== 'deny') {
      decision = await this.applyAiChecks(decision, stored.body, verified, quote, proposal.untrustedContext);
    } else {
      // Already denied, but the free pattern scan still records *why* the request looked hostile.
      const quick = heuristicInjectionScan(proposal.untrustedContext);
      if (quick.suspicious) {
        decision = tighten(decision, [{ code: 'INJECTION_SUSPECTED', message: `Content aimed at the agent was ignored (${quick.matches.join('; ')}).`, source: 'ai' }], 'deny');
      }
    }

    this.d.audit.append('AUTHORIZATION_DECISION', {
      idempotencyKey: proposal.idempotencyKey,
      mandateId: proposal.mandateId,
      merchantId: proposal.merchantId,
      verdict: decision.verdict,
      totalMinor: decision.totalMinor,
      reasons: decision.reasons,
      aiProvider: this.d.ai.name,
    });

    if (decision.verdict === 'deny') return this.settleDenied(proposal, hash, decision, true);

    if (decision.verdict === 'needs_approval') {
      const approval: ApprovalRecord = {
        id: randomUUID(),
        proposalHash: hash,
        proposal: verified,
        decision,
        status: 'pending',
        requestedAt: now.toISOString(),
      };
      store.approvals.set(approval.id, approval);
      const result: AuthorizationResult = { status: 'pending_approval', decision, approvalId: approval.id };
      store.decisions.set(proposal.idempotencyKey, { proposalHash: hash, result });
      this.d.audit.append('APPROVAL_REQUESTED', { approvalId: approval.id, reasons: decision.reasons });
      return result;
    }

    return this.executeOrder(verified, stored.body, decision, hash);
  }

  /** Replace every agent claim with merchant truth and report each disagreement. */
  private verifyAgainstCatalog(proposal: PaymentProposal): { verified: PaymentProposal; findings: Reason[] } {
    const findings: Reason[] = [];
    const add = (code: string, message: string) => findings.push({ code, message, source: 'catalog' });

    const items = proposal.items.map((claimed) => {
      const real = this.d.catalog.lookup(proposal.merchantId, claimed.sku);
      if (!real) {
        add('UNKNOWN_SKU', `SKU ${claimed.sku} is not in ${proposal.merchantId}'s catalogue.`);
        return claimed;
      }
      if (real.unitPriceMinor !== claimed.unitPriceMinor) {
        add('PRICE_DRIFT', `Agent claimed ${formatMoney(claimed.unitPriceMinor, proposal.currency)} for ${claimed.sku}; merchant charges ${formatMoney(real.unitPriceMinor, real.currency)}.`);
      }
      if (real.category.toLowerCase() !== claimed.category.toLowerCase()) {
        add('CATEGORY_MISMATCH', `Agent labelled ${claimed.sku} as "${claimed.category}"; merchant lists it as "${real.category}".`);
      }
      if (real.currency !== proposal.currency) {
        add('CURRENCY_MISMATCH', `${claimed.sku} is priced in ${real.currency}, not ${proposal.currency}.`);
      }
      return { sku: claimed.sku, name: real.name, category: real.category, unitPriceMinor: real.unitPriceMinor, quantity: claimed.quantity };
    });

    const lines = items.map((i) => ({ sku: i.sku, quantity: i.quantity }));
    const shipping = this.d.catalog.shippingMinor(proposal.merchantId, proposal.currency, lines);
    const tax = this.d.catalog.taxMinor(proposal.merchantId, proposal.currency, lines);
    if (shipping !== proposal.shippingMinor) {
      add('SHIPPING_DRIFT', `Agent assumed shipping of ${formatMoney(proposal.shippingMinor, proposal.currency)}; merchant now charges ${formatMoney(shipping, proposal.currency)}.`);
    }
    if (tax !== proposal.taxMinor) {
      add('TAX_DRIFT', `Agent assumed tax of ${formatMoney(proposal.taxMinor, proposal.currency)}; merchant charges ${formatMoney(tax, proposal.currency)}.`);
    }
    return { verified: { ...proposal, items, shippingMinor: shipping, taxMinor: tax }, findings };
  }

  private async applyAiChecks(
    decision: Decision,
    mandate: MandateBody,
    verified: PaymentProposal,
    quote: Quote | undefined,
    untrusted: string | undefined,
  ): Promise<Decision> {
    const ai = (code: string, message: string): Reason[] => [{ code, message, source: 'ai' }];
    try {
      const quick = heuristicInjectionScan(untrusted);
      const deep = untrusted ? await this.d.ai.scanUntrusted(untrusted) : undefined;
      if (quick.suspicious || deep?.suspicious) {
        const why = [...quick.matches, deep?.suspicious ? deep.reason : ''].filter(Boolean).join('; ');
        decision = tighten(decision, ai('INJECTION_SUSPECTED', `Merchant or web content contains instructions aimed at the agent (${why}). It was ignored, but a person must review.`), 'needs_approval');
      }
      const judgment = await this.d.ai.judgeIntent({ task: mandate.task, proposal: verified, quote });
      if (!judgment.aligned) {
        decision = tighten(
          decision,
          ai('INTENT_MISMATCH', `Basket does not match the task: ${judgment.reason}`),
          judgment.confidence >= 0.7 ? 'deny' : 'needs_approval',
        );
      } else if (judgment.confidence < 0.5) {
        decision = tighten(decision, ai('INTENT_UNCERTAIN', `Low confidence the basket matches the task: ${judgment.reason}`), 'needs_approval');
      }
    } catch (e) {
      // Fail safe: an unavailable or malformed AI answer means "ask a person", never "allow".
      decision = tighten(decision, ai('AI_CHECK_FAILED', `AI review could not complete (${e instanceof Error ? e.message : 'unknown error'}).`), 'needs_approval');
    }
    return decision;
  }

  /** `reasonsAlreadyLogged`: the full reasons are already in an AUTHORIZATION_DECISION entry, so log codes only. */
  private settleDenied(proposal: PaymentProposal, hash: string, decision: Decision, reasonsAlreadyLogged = false): AuthorizationResult {
    this.d.audit.append(
      'PAYMENT_DENIED',
      reasonsAlreadyLogged
        ? { idempotencyKey: proposal.idempotencyKey, codes: decision.reasons.map((r) => r.code) }
        : { idempotencyKey: proposal.idempotencyKey, reasons: decision.reasons },
    );
    const result: AuthorizationResult = { status: 'denied', decision };
    this.d.store.decisions.set(proposal.idempotencyKey, { proposalHash: hash, result });
    return result;
  }

  // ───────────────────────── Approvals (owner action) ─────────────────────────

  async resolveApproval(approvalId: string, approver: string, approve: boolean): Promise<AuthorizationResult> {
    const { store } = this.d;
    const approval = store.approvals.get(approvalId);
    if (!approval) throw new GatewayError('APPROVAL_NOT_FOUND', 'No such approval request.', 404);
    if (approval.status !== 'pending') throw new GatewayError('APPROVAL_ALREADY_RESOLVED', `Approval is already ${approval.status}.`, 409);
    if (!approver.trim()) throw new GatewayError('APPROVER_REQUIRED', 'An approver identity is required.', 400);

    const key = approval.proposal.idempotencyKey;
    approval.resolvedBy = approver;
    approval.resolvedAt = this.d.now().toISOString();

    if (!approve) {
      approval.status = 'rejected';
      const decision: Decision = { ...approval.decision, verdict: 'deny', reasons: [...approval.decision.reasons, { code: 'APPROVAL_REJECTED', message: `Rejected by ${approver}.`, source: 'policy' }] };
      const result: AuthorizationResult = { status: 'denied', decision, approvalId };
      store.decisions.set(key, { proposalHash: approval.proposalHash, result });
      this.d.audit.append('APPROVAL_REJECTED', { approvalId, by: approver });
      return result;
    }

    const stored = store.mandates.get(approval.proposal.mandateId);
    if (!stored) throw new GatewayError('MANDATE_NOT_FOUND', 'Mandate no longer exists.', 404);
    // A human can approve past the threshold or an AI flag, but never past a hard rule.
    // Re-run the deterministic checks against the world as it is NOW (kill switch, expiry, revocation, budget).
    const now = this.d.now();
    const quote = approval.proposal.quoteId ? store.quotes.get(approval.proposal.quoteId) : undefined;
    const recheck = evaluatePolicy({
      mandate: stored,
      signatureValid: this.d.signer.verify(stored),
      revoked: store.revoked.has(stored.body.id),
      killSwitch: store.killSwitch,
      proposal: approval.proposal,
      quote,
      spentInWindowMinor: store.spentInWindow(stored.body.id, now, stored.body.periodDays),
      now,
    });
    // Prices may have moved while the request sat in the queue, so re-verify against the catalogue too.
    const drift = this.verifyAgainstCatalog(approval.proposal).findings;
    const blocked = drift.length > 0 ? tighten(recheck, drift, 'deny') : recheck;
    if (blocked.verdict === 'deny') {
      approval.status = 'rejected';
      const result: AuthorizationResult = { status: 'denied', decision: blocked, approvalId };
      store.decisions.set(key, { proposalHash: approval.proposalHash, result });
      this.d.audit.append('APPROVAL_BLOCKED_BY_POLICY', { approvalId, by: approver, reasons: blocked.reasons });
      return result;
    }

    approval.status = 'approved';
    this.d.audit.append('APPROVAL_GRANTED', { approvalId, by: approver });
    const result = await this.executeOrder(approval.proposal, stored.body, approval.decision, approval.proposalHash, approvalId);
    return result;
  }

  // ───────────────────────── Execution ─────────────────────────

  private async executeOrder(
    verified: PaymentProposal,
    mandate: MandateBody,
    decision: Decision,
    hash: string,
    approvalId?: string,
  ): Promise<AuthorizationResult> {
    const { store } = this.d;
    const now = this.d.now();
    const total = decision.totalMinor;

    // Everything from here to the ledger write is synchronous, so two concurrent
    // purchases cannot both slip under the same budget (no await in between).
    const stillActive = this.activeProblem(mandate, now);
    if (stillActive) {
      const denied: Decision = { verdict: 'deny', totalMinor: total, reasons: [stillActive] };
      return this.settleDenied(verified, hash, denied);
    }
    if (store.spentInWindow(mandate.id, now, mandate.periodDays) + total > mandate.periodLimitMinor) {
      const denied: Decision = {
        verdict: 'deny',
        totalMinor: total,
        reasons: [{ code: 'OVER_PERIOD_LIMIT', message: 'Another purchase used up the remaining budget first.', source: 'policy' }],
      };
      return this.settleDenied(verified, hash, denied);
    }
    const orderId = randomUUID();
    const quote = verified.quoteId ? store.quotes.get(verified.quoteId) : undefined;
    if (quote?.consumedByOrderId) {
      const denied: Decision = {
        verdict: 'deny',
        totalMinor: total,
        reasons: [{ code: 'QUOTE_ALREADY_USED', message: 'This quote was used by another payment first.', source: 'policy' }],
      };
      return this.settleDenied(verified, hash, denied);
    }
    store.ledger.push({ mandateId: mandate.id, orderId, amountMinor: total, ts: now.toISOString() });
    if (quote) quote.consumedByOrderId = orderId;

    try {
      const created = await this.d.paypal.createOrder({
        requestId: verified.idempotencyKey,
        referenceId: orderId,
        currency: verified.currency,
        description: verified.description,
        items: verified.items,
        shippingMinor: verified.shippingMinor,
        taxMinor: verified.taxMinor,
        returnUrl: `${this.d.returnUrl}?order=${orderId}`,
        cancelUrl: `${this.d.cancelUrl}?order=${orderId}`,
      });
      const order: OrderRecord = {
        id: orderId,
        mandateId: mandate.id,
        merchantId: verified.merchantId,
        proposal: verified,
        totalMinor: total,
        currency: verified.currency,
        paypalOrderId: created.paypalOrderId,
        approveUrl: created.approveUrl,
        status: 'created',
        refundedMinor: 0,
        refundCount: 0,
        createdAt: now.toISOString(),
      };
      store.orders.set(orderId, order);
      store.ordersByPaypalId.set(created.paypalOrderId, orderId);
      const result: AuthorizationResult = {
        status: 'order_created',
        decision,
        orderId,
        paypalOrderId: created.paypalOrderId,
        approveUrl: created.approveUrl,
        approvalId,
      };
      store.decisions.set(verified.idempotencyKey, { proposalHash: hash, result });
      this.d.audit.append('ORDER_CREATED', { orderId, paypalOrderId: created.paypalOrderId, totalMinor: total, currency: verified.currency, approvalId });
      return result;
    } catch (e) {
      store.releaseReservation(orderId);
      if (quote && quote.consumedByOrderId === orderId) quote.consumedByOrderId = undefined;
      const message = e instanceof Error ? e.message : 'unknown error';
      this.d.audit.append('PAYPAL_ERROR', { step: 'createOrder', idempotencyKey: verified.idempotencyKey, message });
      // Not cached: a retry with the same key is safe because PayPal-Request-Id de-duplicates.
      return { status: 'failed', decision, error: message };
    }
  }

  /** Authority re-check shared by every step that moves or commits money. */
  private activeProblem(mandate: MandateBody, now: Date): Reason | undefined {
    const { store } = this.d;
    if (store.killSwitch) return { code: 'KILL_SWITCH', message: 'The kill switch is active; all agent spending is frozen.', source: 'policy' };
    if (store.revoked.has(mandate.id)) return { code: 'MANDATE_REVOKED', message: 'This mandate has been revoked.', source: 'policy' };
    if (now.getTime() >= Date.parse(mandate.expiresAt)) return { code: 'MANDATE_EXPIRED', message: 'This mandate has expired.', source: 'policy' };
    const stored = store.mandates.get(mandate.id);
    if (!stored || !this.d.signer.verify(stored)) return { code: 'MANDATE_INVALID_SIGNATURE', message: 'The mandate signature does not verify.', source: 'policy' };
    return undefined;
  }

  private requireOrder(orderId: string): OrderRecord {
    const order = this.d.store.orders.get(orderId);
    if (!order) throw new GatewayError('ORDER_NOT_FOUND', 'No such order.', 404);
    return order;
  }

  getOrder(orderId: string): OrderRecord {
    return this.requireOrder(orderId);
  }

  /** Capture after the human payer approved the order in PayPal checkout. */
  async capture(orderId: string): Promise<OrderRecord> {
    const order = this.requireOrder(orderId);
    if (order.status === 'captured' || order.status === 'refunded_partial' || order.status === 'refunded') return order;
    const stored = this.d.store.mandates.get(order.mandateId);
    const problem = stored ? this.activeProblem(stored.body, this.d.now()) : undefined;
    if (problem) {
      this.d.audit.append('CAPTURE_BLOCKED', { orderId, code: problem.code });
      throw new GatewayError(problem.code, `Capture blocked: ${problem.message}`, 409);
    }
    // A capture PayPal definitively rejected (4xx, e.g. ORDER_NOT_APPROVED) moved no money, so the next
    // attempt may use a fresh PayPal-Request-Id; otherwise PayPal could replay the cached rejection.
    // Network errors and 5xx keep the same id, because that capture may have gone through.
    const rejected = order.rejectedCaptureAttempts ?? 0;
    const requestId = rejected === 0 ? `${order.id}:capture` : `${order.id}:capture:${rejected}`;
    try {
      const res = await this.d.paypal.captureOrder(order.paypalOrderId, requestId);
      if (res.status !== 'COMPLETED' || !res.captureId) {
        this.d.audit.append('CAPTURE_INCOMPLETE', { orderId, status: res.status });
        throw new GatewayError('CAPTURE_INCOMPLETE', `PayPal reported capture status ${res.status}.`, 409);
      }
      if (res.amountMinor !== undefined && res.amountMinor !== order.totalMinor) {
        this.d.audit.append('CAPTURE_AMOUNT_ANOMALY', { orderId, expected: order.totalMinor, got: res.amountMinor });
      }
      order.status = 'captured';
      order.captureId = res.captureId;
      order.capturedMinor = res.amountMinor ?? order.totalMinor;
      this.d.audit.append('PAYMENT_CAPTURED', { orderId, captureId: res.captureId, amountMinor: order.capturedMinor });
      return order;
    } catch (e) {
      if (e instanceof GatewayError) throw e;
      const message = e instanceof Error ? e.message : 'unknown error';
      if (e instanceof PayPalError && e.status >= 400 && e.status < 500) order.rejectedCaptureAttempts = rejected + 1;
      this.d.audit.append('PAYPAL_ERROR', { step: 'capture', orderId, message });
      throw new GatewayError('CAPTURE_FAILED', `PayPal capture failed: ${message}`, 502);
    }
  }

  // ───────────────────────── Fulfilment & remedies (merchant actions) ─────────────────────────

  async reconcileFulfillment(orderId: string, shipped: { sku: string; quantity: number }[]): Promise<{ status: 'ok' | 'exception'; exception?: ExceptionRecord }> {
    const order = this.requireOrder(orderId);
    if (!order.captureId) throw new GatewayError('ORDER_NOT_CAPTURED', 'Only captured orders can be reconciled.', 409);

    const shippedBySku = new Map<string, number>();
    for (const s of shipped) shippedBySku.set(s.sku, (shippedBySku.get(s.sku) ?? 0) + s.quantity);
    const diffs: FulfillmentDiff[] = [];
    for (const item of order.proposal.items) {
      const got = shippedBySku.get(item.sku) ?? 0;
      if (got !== item.quantity) diffs.push({ sku: item.sku, expectedQty: item.quantity, shippedQty: got, unitPriceMinor: item.unitPriceMinor });
    }
    const expected = new Set(order.proposal.items.map((i) => i.sku));
    for (const [sku, qty] of shippedBySku) if (!expected.has(sku)) diffs.push({ sku, expectedQty: 0, shippedQty: qty, unitPriceMinor: 0 });

    if (diffs.length === 0) {
      this.d.audit.append('FULFILLMENT_MATCHED', { orderId });
      return { status: 'ok' };
    }

    const remaining = (order.capturedMinor ?? order.totalMinor) - order.refundedMinor;
    let proposedRemedy: RemedyProposal | undefined;
    try {
      proposedRemedy = await this.d.ai.proposeRemedy({ diffs, remainingRefundableMinor: remaining, policyText: this.d.merchantPolicyText ?? DEFAULT_POLICY });
      if (proposedRemedy.refundAmountMinor !== undefined && proposedRemedy.refundAmountMinor > remaining) {
        proposedRemedy = { ...proposedRemedy, refundAmountMinor: remaining };
      }
    } catch {
      proposedRemedy = { action: 'escalate', rationale: 'AI remedy suggestion was unavailable; route to a person.' };
    }
    const exception: ExceptionRecord = {
      id: randomUUID(),
      orderId,
      type: 'FULFILLMENT_MISMATCH',
      diffs,
      proposedRemedy,
      status: 'open',
      createdAt: this.d.now().toISOString(),
    };
    this.d.store.exceptions.set(exception.id, exception);
    this.d.audit.append('FULFILLMENT_MISMATCH', { orderId, exceptionId: exception.id, diffs, proposedRemedy });
    return { status: 'exception', exception };
  }

  /** The merchant, a human, approves (or overrides) the proposed remedy. The AI cannot do this itself. */
  async approveRemedy(exceptionId: string, approvedBy: string, override?: RemedyProposal): Promise<ExceptionRecord> {
    const ex = this.d.store.exceptions.get(exceptionId);
    if (!ex) throw new GatewayError('EXCEPTION_NOT_FOUND', 'No such exception.', 404);
    if (ex.status !== 'open') throw new GatewayError('EXCEPTION_RESOLVED', 'Exception is already resolved.', 409);
    if (!approvedBy.trim()) throw new GatewayError('APPROVER_REQUIRED', 'An approver identity is required.', 400);
    const remedy = override ?? ex.proposedRemedy;
    if (!remedy) throw new GatewayError('NO_REMEDY', 'No remedy to approve.', 422);

    let refundedMinor: number | undefined;
    if (remedy.action === 'partial_refund' || remedy.action === 'full_refund') {
      const order = this.requireOrder(ex.orderId);
      const remaining = (order.capturedMinor ?? order.totalMinor) - order.refundedMinor;
      const amount = remedy.action === 'full_refund' ? remaining : remedy.refundAmountMinor;
      if (amount === undefined || amount <= 0) throw new GatewayError('REFUND_AMOUNT_REQUIRED', 'A refund amount is required.', 422);
      await this.refund({ orderId: ex.orderId, amountMinor: amount, approvedBy, reason: remedy.rationale });
      refundedMinor = amount;
    }
    ex.status = 'resolved';
    ex.resolution = { action: remedy.action, approvedBy, refundedMinor, at: this.d.now().toISOString() };
    this.d.audit.append('REMEDY_APPROVED', { exceptionId, approvedBy, action: remedy.action, refundedMinor });
    return ex;
  }

  async refund(input: { orderId: string; amountMinor: number; approvedBy: string; reason: string }): Promise<OrderRecord> {
    const order = this.requireOrder(input.orderId);
    if (!input.approvedBy.trim()) throw new GatewayError('APPROVER_REQUIRED', 'Refunds require a named human approver.', 400);
    if (!order.captureId) throw new GatewayError('ORDER_NOT_CAPTURED', 'Only captured orders can be refunded.', 409);
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw new GatewayError('INVALID_AMOUNT', 'Refund amount must be a positive integer in minor units.', 400);
    const remaining = (order.capturedMinor ?? order.totalMinor) - order.refundedMinor;
    if (input.amountMinor > remaining) {
      this.d.audit.append('REFUND_REJECTED', { orderId: order.id, requested: input.amountMinor, remaining });
      throw new GatewayError('REFUND_EXCEEDS_REMAINING', `Only ${formatMoney(remaining, order.currency)} remains refundable.`, 422);
    }
    try {
      const res = await this.d.paypal.refundCapture({
        requestId: `${order.id}:refund:${order.refundCount + 1}`,
        captureId: order.captureId,
        amountMinor: input.amountMinor,
        currency: order.currency,
        note: input.reason,
      });
      order.refundedMinor += res.amountMinor;
      order.refundCount += 1;
      order.status = order.refundedMinor >= (order.capturedMinor ?? order.totalMinor) ? 'refunded' : 'refunded_partial';
      this.d.audit.append('REFUND_EXECUTED', { orderId: order.id, refundId: res.refundId, amountMinor: res.amountMinor, approvedBy: input.approvedBy, reason: input.reason });
      return order;
    } catch (e) {
      const message = e instanceof Error ? e.message : 'unknown error';
      this.d.audit.append('PAYPAL_ERROR', { step: 'refund', orderId: order.id, message });
      throw new GatewayError('REFUND_FAILED', `PayPal refund failed: ${message}`, 502);
    }
  }

  // ───────────────────────── Webhooks ─────────────────────────

  async handleWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<{ handled: boolean }> {
    const valid = await this.d.paypal.verifyWebhook({ headers, rawBody });
    if (!valid) {
      this.d.audit.append('WEBHOOK_REJECTED', { reason: 'signature verification failed' });
      throw new GatewayError('WEBHOOK_SIGNATURE_INVALID', 'Webhook signature could not be verified.', 401);
    }
    let event: { id?: string; event_type?: string; resource?: Record<string, unknown> };
    try {
      event = JSON.parse(rawBody) as typeof event;
    } catch {
      throw new GatewayError('WEBHOOK_BAD_BODY', 'Webhook body is not JSON.', 400);
    }
    if (!event.id || !event.event_type) throw new GatewayError('WEBHOOK_BAD_BODY', 'Webhook is missing id or event_type.', 400);
    if (this.d.store.webhookEvents.has(event.id)) return { handled: false };
    this.d.store.webhookEvents.add(event.id);
    this.d.audit.append('WEBHOOK_RECEIVED', { eventId: event.id, type: event.event_type });

    const resource = event.resource ?? {};
    const related = (resource['supplementary_data'] as { related_ids?: { order_id?: string } } | undefined)?.related_ids;
    const paypalOrderId = event.event_type === 'CHECKOUT.ORDER.APPROVED' ? (resource['id'] as string | undefined) : related?.order_id;
    const orderId = paypalOrderId ? this.d.store.ordersByPaypalId.get(paypalOrderId) : undefined;
    const order = orderId ? this.d.store.orders.get(orderId) : undefined;
    if (!order) return { handled: true };

    if (event.event_type === 'CHECKOUT.ORDER.APPROVED' && order.status === 'created') {
      order.status = 'approved';
      this.d.audit.append('ORDER_PAYER_APPROVED', { orderId: order.id });
    } else if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
      const amount = (resource['amount'] as { value?: string } | undefined)?.value;
      let paidMinor: number | undefined;
      try {
        paidMinor = amount ? decimalToMinor(amount) : undefined;
      } catch {
        paidMinor = undefined;
      }
      if (paidMinor !== undefined && paidMinor !== order.totalMinor) {
        this.d.audit.append('WEBHOOK_AMOUNT_MISMATCH', { orderId: order.id, expected: order.totalMinor, got: paidMinor });
      }
      if (order.status === 'created' || order.status === 'approved') {
        order.status = 'captured';
        order.captureId = (resource['id'] as string | undefined) ?? order.captureId;
        order.capturedMinor = paidMinor ?? order.totalMinor;
        this.d.audit.append('PAYMENT_CAPTURED', { orderId: order.id, via: 'webhook', captureId: order.captureId });
      }
    }
    return { handled: true };
  }

  // ───────────────────────── Read models ─────────────────────────

  auditEntries() {
    return this.d.audit.entries();
  }

  state() {
    const s = this.d.store;
    return {
      killSwitch: s.killSwitch,
      aiProvider: this.d.ai.name,
      mandates: [...s.mandates.values()].map((m) => ({ ...m.body, revoked: s.revoked.has(m.body.id), signatureValid: this.d.signer.verify(m) })),
      quotes: [...s.quotes.values()],
      pendingApprovals: [...s.approvals.values()].filter((a) => a.status === 'pending'),
      orders: [...s.orders.values()],
      exceptions: [...s.exceptions.values()],
      audit: { ...this.d.audit.verify(), head: this.d.audit.head() },
    };
  }
}

const DEFAULT_POLICY =
  'Wrong item shipped: offer an exchange for the approved item. Item short-shipped: refund the unshipped value. ' +
  'Nothing shipped: full refund. Any refund requires merchant approval.';
