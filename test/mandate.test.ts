import { describe, expect, it } from 'vitest';
import { HeuristicProvider } from '../src/ai/heuristic.js';
import { DraftMandateSchema, type MandateBody } from '../src/domain/schemas.js';
import { MandateSigner } from '../src/mandate/sign.js';
import { summarizeMandate } from '../src/mandate/summary.js';
import { decimalToMinor, minorToDecimal } from '../src/util/money.js';
import { canonicalJson } from '../src/util/canonical.js';
import { NL } from './helpers.js';

const body = (over: Partial<MandateBody> = {}): MandateBody => ({
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
  allowedMerchants: ['shop'],
  deniedCategories: ['gift_card'],
  requireQuote: true,
  notBefore: '2026-10-20T10:00:00.000Z',
  expiresAt: '2026-10-23T10:00:00.000Z',
  createdAt: '2026-10-20T10:00:00.000Z',
  ...over,
});

describe('MandateSigner', () => {
  it('verifies an untouched mandate', () => {
    const s = new MandateSigner();
    expect(s.verify(s.sign(body()))).toBe(true);
  });

  it.each([
    ['a raised limit', { perPurchaseLimitMinor: 9_999_999 }],
    ['a widened merchant list', { allowedMerchants: [] }],
    ['a removed category block', { deniedCategories: [] }],
    ['a switched agent', { agentId: 'intruder' }],
    ['an extended expiry', { expiresAt: '2030-01-01T00:00:00.000Z' }],
  ])('rejects a mandate with %s', (_n, change) => {
    const s = new MandateSigner();
    const signed = s.sign(body());
    expect(s.verify({ ...signed, body: { ...signed.body, ...change } })).toBe(false);
  });

  it('rejects a signature from a different key and a garbage signature', () => {
    const a = new MandateSigner();
    const b = new MandateSigner();
    const signedByA = a.sign(body());
    expect(b.verify(signedByA)).toBe(false);
    expect(a.verify({ ...signedByA, signature: 'not-base64-$$$' })).toBe(false);
  });

  it('is stable regardless of key order in the body', () => {
    const s = new MandateSigner();
    const signed = s.sign(body());
    const shuffled = Object.fromEntries(Object.entries(signed.body).reverse()) as MandateBody;
    expect(s.verify({ ...signed, body: shuffled })).toBe(true);
  });

  it('keeps the same identity when loaded from a PEM key', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const one = new MandateSigner(pem);
    const two = new MandateSigner(pem);
    expect(one.keyId).toBe(two.keyId);
    expect(two.verify(one.sign(body()))).toBe(true);
  });
});

describe('DraftMandateSchema', () => {
  const draft = {
    task: 't',
    currency: 'USD',
    perPurchaseLimitMinor: 5000,
    periodLimitMinor: 10000,
    periodDays: 30,
    approvalThresholdMinor: 4000,
    expiresInHours: 24,
  };

  it('applies safe defaults', () => {
    const d = DraftMandateSchema.parse(draft);
    expect(d.requireQuote).toBe(true);
    expect(d.allowedMerchants).toEqual([]);
  });

  it('rejects an approval threshold above the limit, a period limit below it and unsupported currencies', () => {
    expect(DraftMandateSchema.safeParse({ ...draft, approvalThresholdMinor: 6000 }).success).toBe(false);
    expect(DraftMandateSchema.safeParse({ ...draft, periodLimitMinor: 4000 }).success).toBe(false);
    expect(DraftMandateSchema.safeParse({ ...draft, currency: 'JPY' }).success).toBe(false);
  });

  it('rejects fractional or negative minor units', () => {
    expect(DraftMandateSchema.safeParse({ ...draft, perPurchaseLimitMinor: 50.5 }).success).toBe(false);
    expect(DraftMandateSchema.safeParse({ ...draft, perPurchaseLimitMinor: -1 }).success).toBe(false);
  });
});

describe('HeuristicProvider.compileMandate', () => {
  const ai = new HeuristicProvider();

  it('parses limits, merchants, blocked categories, approval threshold and expiry', async () => {
    const d = await ai.compileMandate(NL);
    expect(d).toMatchObject({
      currency: 'USD',
      perPurchaseLimitMinor: 6000,
      periodLimitMinor: 20000,
      periodDays: 30,
      approvalThresholdMinor: 5000,
      allowedMerchants: ['fernlight-electronics'],
      deniedCategories: ['gift_card'],
      requireQuote: true,
      expiresInHours: 72,
    });
  });

  it('fails closed when no per-purchase limit is stated', async () => {
    await expect(ai.compileMandate('Please buy me a nice charger, whatever it costs.')).rejects.toThrow(/per-purchase limit/);
  });

  it('defaults the period budget to a single purchase rather than guessing a bigger one', async () => {
    const d = await ai.compileMandate('Buy a charger. Max $40 per purchase.');
    expect(d.periodLimitMinor).toBe(4000);
    expect(d.approvalThresholdMinor).toBe(4000);
  });

  it('understands other currencies and weekly budgets', async () => {
    const d = await ai.compileMandate('Buy a charger. £30 per order, £90 per week.');
    expect(d).toMatchObject({ currency: 'GBP', perPurchaseLimitMinor: 3000, periodLimitMinor: 9000, periodDays: 7 });
  });
});

describe('summarizeMandate', () => {
  it('is rendered from the structured values, so it cannot soften them', async () => {
    const d = await new HeuristicProvider().compileMandate(NL);
    const text = summarizeMandate(d).join('\n');
    expect(text).toContain('USD 60.00');
    expect(text).toContain('USD 200.00');
    expect(text).toContain('gift_card');
    expect(text).toContain('fernlight-electronics');
    expect(text).toContain('Ask you first for any purchase above USD 50.00');
  });
});

describe('helpers', () => {
  it('money conversion round-trips and rejects bad input', () => {
    expect(minorToDecimal(12345)).toBe('123.45');
    expect(minorToDecimal(5)).toBe('0.05');
    expect(decimalToMinor('123.45')).toBe(12345);
    expect(decimalToMinor('7')).toBe(700);
    expect(decimalToMinor('7.5')).toBe(750);
    expect(() => decimalToMinor('1.234')).toThrow();
    expect(() => minorToDecimal(-1)).toThrow();
    expect(() => minorToDecimal(1.5)).toThrow();
  });

  it('canonicalJson sorts keys deeply and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: [{ z: 1, y: undefined, x: 2 }] } })).toBe('{"a":{"c":[{"x":2,"z":1}],"d":1},"b":1}');
  });
});
