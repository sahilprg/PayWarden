import { describe, expect, it } from 'vitest';
import type { MandateBody, PaymentProposal, SignedMandate } from '../src/domain/schemas.js';
import type { Decision, Quote } from '../src/domain/types.js';
import { computeTotalMinor, evaluatePolicy, tighten, type PolicyInput } from '../src/policy/engine.js';

const NOW = new Date('2026-10-20T10:00:00Z');
const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

function mandate(over: Partial<MandateBody> = {}): SignedMandate {
  return {
    body: {
      id: 'm1',
      version: 1,
      subject: 'user',
      agentId: 'agent-1',
      task: 'buy a charger',
      currency: 'USD',
      perPurchaseLimitMinor: 6000,
      periodLimitMinor: 20000,
      periodDays: 30,
      approvalThresholdMinor: 5000,
      allowedMerchants: [],
      deniedCategories: [],
      requireQuote: false,
      notBefore: iso(-3_600_000),
      expiresAt: iso(3_600_000),
      createdAt: iso(-3_600_000),
      ...over,
    },
    signature: 'x',
    keyId: 'k',
  };
}

function proposal(over: Partial<PaymentProposal> = {}): PaymentProposal {
  return {
    idempotencyKey: 'key-12345678',
    mandateId: 'm1',
    agentId: 'agent-1',
    merchantId: 'shop',
    items: [{ sku: 'a', name: 'A', category: 'electronics', unitPriceMinor: 3400, quantity: 1 }],
    shippingMinor: 600,
    taxMinor: 0,
    currency: 'USD',
    description: 'd',
    ...over,
  };
}

function run(over: Partial<PolicyInput> = {}): Decision {
  return evaluatePolicy({
    mandate: mandate(),
    signatureValid: true,
    revoked: false,
    killSwitch: false,
    proposal: proposal(),
    spentInWindowMinor: 0,
    now: NOW,
    ...over,
  });
}

const codes = (d: Decision) => d.reasons.map((r) => r.code);

describe('evaluatePolicy', () => {
  it('allows a compliant purchase and computes the total from items, shipping and tax', () => {
    const d = run({ proposal: proposal({ taxMinor: 100 }) });
    expect(d.verdict).toBe('allow');
    expect(d.totalMinor).toBe(4100);
  });

  it('denies a purchase over the per-purchase limit', () => {
    const d = run({ proposal: proposal({ shippingMinor: 4200 }) });
    expect(d.verdict).toBe('deny');
    expect(codes(d)).toContain('OVER_PER_PURCHASE_LIMIT');
  });

  it('denies when the rolling period budget would be exceeded', () => {
    const d = run({ spentInWindowMinor: 18000 });
    expect(d.verdict).toBe('deny');
    expect(codes(d)).toContain('OVER_PERIOD_LIMIT');
  });

  it('allows spending that lands exactly on the period limit', () => {
    expect(run({ spentInWindowMinor: 16000 }).verdict).toBe('allow');
  });

  it('enforces the merchant allow-list only when one is set', () => {
    expect(run({ mandate: mandate({ allowedMerchants: ['other'] }) }).verdict).toBe('deny');
    expect(codes(run({ mandate: mandate({ allowedMerchants: ['other'] }) }))).toContain('MERCHANT_NOT_ALLOWED');
    expect(run({ mandate: mandate({ allowedMerchants: ['shop'] }) }).verdict).toBe('allow');
  });

  it('blocks denied categories case-insensitively', () => {
    const d = run({
      mandate: mandate({ deniedCategories: ['gift_card'] }),
      proposal: proposal({ items: [{ sku: 'g', name: 'G', category: 'Gift_Card', unitPriceMinor: 1000, quantity: 1 }] }),
    });
    expect(codes(d)).toContain('CATEGORY_DENIED');
  });

  it.each([
    ['invalid signature', { signatureValid: false }, 'MANDATE_INVALID_SIGNATURE'],
    ['revoked', { revoked: true }, 'MANDATE_REVOKED'],
    ['kill switch', { killSwitch: true }, 'KILL_SWITCH'],
    ['expired', { now: new Date(NOW.getTime() + 7_200_000) }, 'MANDATE_EXPIRED'],
    ['not yet active', { now: new Date(NOW.getTime() - 7_200_000) }, 'MANDATE_NOT_ACTIVE'],
    ['wrong agent', { proposal: proposal({ agentId: 'intruder' }) }, 'AGENT_MISMATCH'],
    ['wrong mandate id', { proposal: proposal({ mandateId: 'm2' }) }, 'MANDATE_MISMATCH'],
    ['wrong currency', { proposal: proposal({ currency: 'EUR' }) }, 'CURRENCY_MISMATCH'],
  ] as const)('denies on %s', (_name, over, code) => {
    const d = run(over as Partial<PolicyInput>);
    expect(d.verdict).toBe('deny');
    expect(codes(d)).toContain(code);
  });

  describe('quotes', () => {
    const quote = (over: Partial<Quote> = {}): Quote => ({
      id: 'q1',
      mandateId: 'm1',
      merchantId: 'shop',
      items: [{ sku: 'a', quantity: 1 }],
      maxTotalMinor: 4500,
      approvedBy: 'user',
      createdAt: iso(0),
      ...over,
    });
    const strict = mandate({ requireQuote: true });

    it('requires a quote when the mandate says so', () => {
      expect(codes(run({ mandate: strict }))).toContain('QUOTE_REQUIRED');
    });

    it('allows a basket that matches the approved quote', () => {
      expect(run({ mandate: strict, proposal: proposal({ quoteId: 'q1' }), quote: quote() }).verdict).toBe('allow');
    });

    it('denies an unknown quote or one belonging to another mandate or merchant', () => {
      expect(codes(run({ mandate: strict, proposal: proposal({ quoteId: 'q1' }) }))).toContain('QUOTE_NOT_FOUND');
      expect(codes(run({ mandate: strict, proposal: proposal({ quoteId: 'q1' }), quote: quote({ mandateId: 'other' }) }))).toContain('QUOTE_NOT_FOUND');
      expect(codes(run({ mandate: strict, proposal: proposal({ quoteId: 'q1' }), quote: quote({ merchantId: 'other' }) }))).toContain('QUOTE_NOT_FOUND');
    });

    it('denies a swapped SKU, a changed quantity, an extra item and a missing item', () => {
      const swapped = proposal({ quoteId: 'q1', items: [{ sku: 'b', name: 'B', category: 'electronics', unitPriceMinor: 3400, quantity: 1 }] });
      expect(codes(run({ mandate: strict, proposal: swapped, quote: quote() }))).toContain('QUOTE_MISMATCH');

      const doubled = proposal({ quoteId: 'q1', items: [{ sku: 'a', name: 'A', category: 'electronics', unitPriceMinor: 1000, quantity: 2 }] });
      expect(codes(run({ mandate: strict, proposal: doubled, quote: quote() }))).toContain('QUOTE_MISMATCH');

      const extra = proposal({
        quoteId: 'q1',
        items: [
          { sku: 'a', name: 'A', category: 'electronics', unitPriceMinor: 3400, quantity: 1 },
          { sku: 'z', name: 'Z', category: 'electronics', unitPriceMinor: 100, quantity: 1 },
        ],
      });
      expect(codes(run({ mandate: strict, proposal: extra, quote: quote() }))).toContain('QUOTE_MISMATCH');

      const wantsTwo = quote({ items: [{ sku: 'a', quantity: 1 }, { sku: 'z', quantity: 1 }] });
      expect(codes(run({ mandate: strict, proposal: proposal({ quoteId: 'q1' }), quote: wantsTwo }))).toContain('QUOTE_MISMATCH');
    });

    it('denies a total above the quote ceiling and a quote that was already used', () => {
      expect(codes(run({ mandate: strict, proposal: proposal({ quoteId: 'q1' }), quote: quote({ maxTotalMinor: 3900 }) }))).toContain('QUOTE_OVER_BUDGET');
      expect(codes(run({ mandate: strict, proposal: proposal({ quoteId: 'q1' }), quote: quote({ consumedByOrderId: 'o1' }) }))).toContain('QUOTE_ALREADY_USED');
    });

    it('still enforces a quote that was supplied even when the mandate does not require one', () => {
      const lax = mandate({ requireQuote: false });
      const swapped = proposal({ quoteId: 'q1', items: [{ sku: 'b', name: 'B', category: 'electronics', unitPriceMinor: 3400, quantity: 1 }] });
      expect(run({ mandate: lax, proposal: swapped, quote: quote() }).verdict).toBe('deny');
    });
  });

  it('asks for approval above the threshold but within the limit', () => {
    const d = run({ proposal: proposal({ shippingMinor: 1800 }) }); // 5200 > 5000 threshold, < 6000 limit
    expect(d.verdict).toBe('needs_approval');
    expect(codes(d)).toEqual(['APPROVAL_THRESHOLD']);
  });

  it('reports every hard failure at once, and a deny never degrades into an approval request', () => {
    const d = run({ revoked: true, killSwitch: true, proposal: proposal({ shippingMinor: 1800, currency: 'EUR' }) });
    expect(d.verdict).toBe('deny');
    expect(codes(d)).toEqual(expect.arrayContaining(['MANDATE_REVOKED', 'KILL_SWITCH', 'CURRENCY_MISMATCH']));
    expect(codes(d)).not.toContain('APPROVAL_THRESHOLD');
  });
});

describe('tighten', () => {
  const allow: Decision = { verdict: 'allow', reasons: [], totalMinor: 100 };
  const r = (code: string) => [{ code, message: code, source: 'ai' as const }];

  it('only ever moves toward stricter verdicts', () => {
    expect(tighten(allow, r('a'), 'needs_approval').verdict).toBe('needs_approval');
    expect(tighten(allow, r('a'), 'deny').verdict).toBe('deny');
    const denied: Decision = { verdict: 'deny', reasons: r('x'), totalMinor: 100 };
    expect(tighten(denied, r('a'), 'allow').verdict).toBe('deny');
    expect(tighten(denied, r('a'), 'needs_approval').verdict).toBe('deny');
    const approval: Decision = { verdict: 'needs_approval', reasons: r('x'), totalMinor: 100 };
    expect(tighten(approval, r('a'), 'allow').verdict).toBe('needs_approval');
  });

  it('keeps all reasons and does not mutate its input', () => {
    const out = tighten(allow, r('a'), 'deny');
    expect(out.reasons.map((x) => x.code)).toEqual(['a']);
    expect(allow.reasons).toHaveLength(0);
  });
});

describe('computeTotalMinor', () => {
  it('uses integer arithmetic across quantities', () => {
    expect(
      computeTotalMinor({
        items: [
          { sku: 'a', name: 'A', category: 'c', unitPriceMinor: 1999, quantity: 3 },
          { sku: 'b', name: 'B', category: 'c', unitPriceMinor: 1, quantity: 7 },
        ],
        shippingMinor: 499,
        taxMinor: 12,
      }),
    ).toBe(1999 * 3 + 7 + 499 + 12);
  });
});
