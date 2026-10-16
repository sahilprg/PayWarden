import { z } from 'zod';
import { SUPPORTED_CURRENCIES } from '../util/money.js';

/** Integer minor units (cents). Capped at 10,000,000.00 to keep arithmetic safe. */
const Minor = z.number().int().min(0).max(1_000_000_000);
const Currency = z.enum(SUPPORTED_CURRENCIES);
const Slug = z.string().min(1).max(64);

/** The signed part of a mandate: the human's delegated authority, in code. */
export const MandateBodySchema = z.object({
  id: z.string().min(1),
  version: z.literal(1),
  subject: z.string().min(1).max(200),
  agentId: Slug,
  task: z.string().min(1).max(2000),
  currency: Currency,
  perPurchaseLimitMinor: Minor,
  periodLimitMinor: Minor,
  periodDays: z.number().int().min(1).max(365),
  approvalThresholdMinor: Minor,
  allowedMerchants: z.array(Slug).max(100),
  deniedCategories: z.array(Slug).max(100),
  requireQuote: z.boolean(),
  notBefore: z.string().datetime(),
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});
export type MandateBody = z.infer<typeof MandateBodySchema>;

export interface SignedMandate {
  body: MandateBody;
  /** base64 Ed25519 signature over canonicalJson(body). */
  signature: string;
  keyId: string;
}

/** What the AI (or a human) proposes before the gateway signs it. */
export const DraftMandateSchema = z
  .object({
    task: z.string().min(1).max(2000),
    currency: Currency,
    perPurchaseLimitMinor: Minor,
    periodLimitMinor: Minor,
    periodDays: z.number().int().min(1).max(365),
    approvalThresholdMinor: Minor,
    allowedMerchants: z.array(Slug).max(100).default([]),
    deniedCategories: z.array(Slug).max(100).default([]),
    requireQuote: z.boolean().default(true),
    expiresInHours: z.number().int().min(1).max(24 * 90),
  })
  .refine((d) => d.approvalThresholdMinor <= d.perPurchaseLimitMinor, {
    message: 'approvalThresholdMinor must not exceed perPurchaseLimitMinor',
    path: ['approvalThresholdMinor'],
  })
  .refine((d) => d.periodLimitMinor >= d.perPurchaseLimitMinor, {
    message: 'periodLimitMinor must be at least perPurchaseLimitMinor',
    path: ['periodLimitMinor'],
  });
export type DraftMandate = z.infer<typeof DraftMandateSchema>;

export const LineItemSchema = z.object({
  sku: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  category: Slug,
  unitPriceMinor: Minor,
  quantity: z.number().int().min(1).max(1000),
});
export type LineItem = z.infer<typeof LineItemSchema>;

/**
 * What an agent asks the gateway to pay for. Everything here is an agent
 * *claim*: prices, categories and shipping are re-checked against the
 * merchant catalogue, and `untrustedContext` is never obeyed.
 */
export const PaymentProposalSchema = z.object({
  idempotencyKey: z.string().min(8).max(128),
  mandateId: z.string().min(1),
  agentId: Slug,
  merchantId: Slug,
  items: z.array(LineItemSchema).min(1).max(50),
  shippingMinor: Minor,
  taxMinor: Minor.default(0),
  currency: Currency,
  description: z.string().min(1).max(500),
  quoteId: z.string().min(1).optional(),
  untrustedContext: z.string().max(20_000).optional(),
});
export type PaymentProposal = z.infer<typeof PaymentProposalSchema>;

/** A buyer-approved quote: the exact basket and ceiling a payment must match. */
export const QuoteInputSchema = z.object({
  mandateId: z.string().min(1),
  merchantId: Slug,
  items: z
    .array(z.object({ sku: z.string().min(1).max(64), quantity: z.number().int().min(1).max(1000) }))
    .min(1)
    .max(50),
  maxTotalMinor: Minor,
  approvedBy: z.string().min(1).max(200),
});
export type QuoteInput = z.infer<typeof QuoteInputSchema>;

export const IntentJudgmentSchema = z.object({
  aligned: z.boolean(),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(1000),
});
export type IntentJudgment = z.infer<typeof IntentJudgmentSchema>;

export const InjectionFindingSchema = z.object({
  suspicious: z.boolean(),
  reason: z.string().max(1000),
});
export type InjectionFinding = z.infer<typeof InjectionFindingSchema>;

export const RemedyProposalSchema = z.object({
  action: z.enum([
    'correct_shipment',
    'exchange',
    'partial_refund',
    'full_refund',
    'request_evidence',
    'escalate',
  ]),
  refundAmountMinor: Minor.optional(),
  rationale: z.string().max(1000),
});
export type RemedyProposal = z.infer<typeof RemedyProposalSchema>;
