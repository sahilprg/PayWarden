import type { PaymentProposal, SignedMandate } from '../domain/schemas.js';
import type { Decision, Quote, Reason, Verdict } from '../domain/types.js';
import { formatMoney } from '../util/money.js';

export interface PolicyInput {
  mandate: SignedMandate;
  signatureValid: boolean;
  revoked: boolean;
  killSwitch: boolean;
  /** Must already be catalogue-verified: prices and categories come from the merchant, not the agent. */
  proposal: PaymentProposal;
  quote?: Quote;
  spentInWindowMinor: number;
  now: Date;
}

const RANK: Record<Verdict, number> = { allow: 0, needs_approval: 1, deny: 2 };

/** Combine verdicts so that the stricter one always wins. Nothing can loosen a decision. */
export function tighten(decision: Decision, reasons: Reason[], verdict: Verdict): Decision {
  return {
    totalMinor: decision.totalMinor,
    verdict: RANK[verdict] > RANK[decision.verdict] ? verdict : decision.verdict,
    reasons: [...decision.reasons, ...reasons],
  };
}

export function computeTotalMinor(p: Pick<PaymentProposal, 'items' | 'shippingMinor' | 'taxMinor'>): number {
  const items = p.items.reduce((sum, i) => sum + i.unitPriceMinor * i.quantity, 0);
  const total = items + p.shippingMinor + p.taxMinor;
  if (!Number.isSafeInteger(total)) throw new RangeError('Total is not a safe integer');
  return total;
}

/**
 * The deterministic heart of Paywarden. Plain code, no model calls, no I/O.
 * Every rule that can say "no" lives here, and the same input always gives
 * the same answer.
 */
export function evaluatePolicy(input: PolicyInput): Decision {
  const { mandate, proposal: p, quote } = input;
  const m = mandate.body;
  const deny: Reason[] = [];
  const approve: Reason[] = [];
  const d = (code: string, message: string) => deny.push({ code, message, source: 'policy' });
  const money = (n: number) => formatMoney(n, m.currency);

  let total = 0;
  try {
    total = computeTotalMinor(p);
  } catch {
    d('INVALID_AMOUNT', 'The payment total is not a valid amount.');
  }

  // --- Authority: is this mandate real, current and not switched off? ---
  if (!input.signatureValid) d('MANDATE_INVALID_SIGNATURE', 'The mandate signature does not verify; it may have been altered.');
  if (input.revoked) d('MANDATE_REVOKED', 'This mandate has been revoked.');
  if (input.killSwitch) d('KILL_SWITCH', 'The kill switch is active; all agent spending is frozen.');
  if (input.now.getTime() < Date.parse(m.notBefore)) d('MANDATE_NOT_ACTIVE', 'This mandate is not active yet.');
  if (input.now.getTime() >= Date.parse(m.expiresAt)) d('MANDATE_EXPIRED', 'This mandate has expired.');
  if (p.mandateId !== m.id) d('MANDATE_MISMATCH', 'The proposal references a different mandate.');
  if (p.agentId !== m.agentId) d('AGENT_MISMATCH', `Agent "${p.agentId}" is not the agent this mandate was issued to.`);

  // --- Limits ---
  if (p.currency !== m.currency) d('CURRENCY_MISMATCH', `Payment is in ${p.currency}; the mandate allows ${m.currency}.`);
  if (total > m.perPurchaseLimitMinor) {
    d('OVER_PER_PURCHASE_LIMIT', `Total ${money(total)} exceeds the per-purchase limit of ${money(m.perPurchaseLimitMinor)}.`);
  }
  if (input.spentInWindowMinor + total > m.periodLimitMinor) {
    d(
      'OVER_PERIOD_LIMIT',
      `${money(input.spentInWindowMinor)} already spent plus ${money(total)} would exceed the ${m.periodDays}-day limit of ${money(m.periodLimitMinor)}.`,
    );
  }

  // --- Scope ---
  if (m.allowedMerchants.length > 0 && !m.allowedMerchants.includes(p.merchantId)) {
    d('MERCHANT_NOT_ALLOWED', `Merchant "${p.merchantId}" is not on the allowed list.`);
  }
  const blocked = new Set(m.deniedCategories.map((c) => c.toLowerCase()));
  const hits = [...new Set(p.items.map((i) => i.category.toLowerCase()).filter((c) => blocked.has(c)))];
  if (hits.length > 0) d('CATEGORY_DENIED', `Blocked categories in basket: ${hits.join(', ')}.`);

  // --- Quote: the buyer-approved basket the payment must match exactly ---
  if (m.requireQuote && !p.quoteId) {
    d('QUOTE_REQUIRED', 'This mandate requires a buyer-approved quote for every purchase.');
  }
  if (p.quoteId) {
    if (!quote || quote.id !== p.quoteId || quote.mandateId !== m.id || quote.merchantId !== p.merchantId) {
      d('QUOTE_NOT_FOUND', 'The referenced quote does not exist for this mandate and merchant.');
    } else {
      if (quote.consumedByOrderId) d('QUOTE_ALREADY_USED', 'This quote has already been used for another payment.');
      const approved = new Map(quote.items.map((i) => [i.sku, i.quantity]));
      const proposed = new Map<string, number>();
      for (const i of p.items) proposed.set(i.sku, (proposed.get(i.sku) ?? 0) + i.quantity);
      const problems: string[] = [];
      for (const [sku, qty] of proposed) {
        const want = approved.get(sku);
        if (want === undefined) problems.push(`${sku} was never approved`);
        else if (want !== qty) problems.push(`${sku} quantity ${qty} differs from approved ${want}`);
      }
      for (const [sku] of approved) if (!proposed.has(sku)) problems.push(`approved item ${sku} is missing`);
      if (problems.length > 0) d('QUOTE_MISMATCH', `Basket differs from the approved quote: ${problems.join('; ')}.`);
      if (total > quote.maxTotalMinor) {
        d('QUOTE_OVER_BUDGET', `Total ${money(total)} exceeds the approved quote ceiling of ${money(quote.maxTotalMinor)}.`);
      }
    }
  }

  if (deny.length > 0) return { verdict: 'deny', reasons: deny, totalMinor: total };

  if (total > m.approvalThresholdMinor) {
    approve.push({
      code: 'APPROVAL_THRESHOLD',
      message: `Total ${money(total)} is above the ${money(m.approvalThresholdMinor)} threshold that needs your approval.`,
      source: 'policy',
    });
  }
  return approve.length > 0
    ? { verdict: 'needs_approval', reasons: approve, totalMinor: total }
    : { verdict: 'allow', reasons: [], totalMinor: total };
}
