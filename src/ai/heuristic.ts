import {
  DraftMandateSchema,
  type DraftMandate,
  type InjectionFinding,
  type IntentJudgment,
  type PaymentProposal,
  type RemedyProposal,
} from '../domain/schemas.js';
import type { FulfillmentDiff, Quote } from '../domain/types.js';
import { decimalToMinor } from '../util/money.js';
import { heuristicInjectionScan } from './injection.js';
import type { AIProvider } from './provider.js';

const AMT = '([$£€])?\\s*(\\d{1,7}(?:\\.\\d{1,2})?)';
const STOP = new Set(['the', 'for', 'with', 'and', 'buy', 'get', 'need', 'want', 'please', 'from', 'that', 'this', 'has', 'have', 'under', 'than', 'more']);

const CATEGORY_PATTERNS: [RegExp, string][] = [
  [/gift\s*cards?/, 'gift_card'],
  [/gambling|betting|casino/, 'gambling'],
  [/crypto(currency)?/, 'crypto'],
  [/alcohol|liquor|wine\b/, 'alcohol'],
  [/tobacco|cigarettes?|vap(e|ing)/, 'tobacco'],
  [/weapons?|firearms?/, 'weapons'],
  [/subscriptions?/, 'subscription'],
];

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOP.has(t))
    .map((t) => (t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t));
}

function slug(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Offline, rule-based provider. It lets the project run, and its tests pass,
 * with no API key. It is deliberately conservative and much weaker than a
 * language model: it is a fallback and a test double, not the intended AI.
 * Where it cannot parse something it FAILS CLOSED instead of guessing.
 */
export class HeuristicProvider implements AIProvider {
  readonly name = 'heuristic-offline';

  async compileMandate(text: string): Promise<DraftMandate> {
    const currency = text.includes('£') ? 'GBP' : text.includes('€') ? 'EUR' : 'USD';
    const per = new RegExp(`${AMT}\\s*(?:per|/|a|each)\\s*(?:single\\s+)?(?:purchase|order|transaction|item)`, 'i').exec(text);
    if (!per) {
      throw new Error('Could not find a per-purchase limit (for example "$50 per purchase"). State one explicitly.');
    }
    const perPurchase = decimalToMinor(per[2]!);

    const period = new RegExp(`${AMT}\\s*(?:per|/|a|each)\\s*(month|week|day)`, 'i').exec(text);
    const periodLimit = period ? decimalToMinor(period[2]!) : perPurchase;
    const periodDays = period ? ({ month: 30, week: 7, day: 1 } as Record<string, number>)[period[3]!.toLowerCase()]! : 30;

    const ask = new RegExp(`(?:ask|approval|confirm|check\\s+with)\\b[^.;]*?(?:above|over)\\s*${AMT}`, 'i').exec(text);
    const threshold = ask ? Math.min(decimalToMinor(ask[2]!), perPurchase) : perPurchase;

    const denied = CATEGORY_PATTERNS.filter(([re]) =>
      new RegExp(`(?:\\bno\\b|\\bnever\\b|\\bnot\\b|avoid|without|don't|do not)[^.;]*${re.source}`, 'i').test(text),
    ).map(([, cat]) => cat);

    const only = /only\s+(?:buy\s+)?(?:from|at|with)\s+([a-z0-9 ,._&-]+?)(?:[.;]|$|\s+(?:and\s+no|no|never|expires?|for|ask|max|maximum|up\s+to|limit)\b)/i.exec(text);
    const allowed = only ? only[1]!.split(/,|\band\b|\bor\b/i).map(slug).filter(Boolean) : [];

    const exp = /(?:expires?|valid)\s*(?:in|for)?\s*(\d+)\s*(hour|day|week)s?/i.exec(text);
    const expiresInHours = exp
      ? Number(exp[1]) * ({ hour: 1, day: 24, week: 168 } as Record<string, number>)[exp[2]!.toLowerCase()]!
      : 72;

    return DraftMandateSchema.parse({
      task: text.trim(),
      currency,
      perPurchaseLimitMinor: perPurchase,
      periodLimitMinor: Math.max(periodLimit, perPurchase),
      periodDays,
      approvalThresholdMinor: threshold,
      allowedMerchants: allowed,
      deniedCategories: denied,
      requireQuote: true,
      expiresInHours,
    });
  }

  async judgeIntent(input: { task: string; proposal: PaymentProposal; quote?: Quote }): Promise<IntentJudgment> {
    const want = new Set(tokens(input.task));
    const stray = input.proposal.items.filter((i) => !tokens(`${i.name} ${i.category}`).some((t) => want.has(t)));
    if (stray.length > 0) {
      return {
        aligned: false,
        confidence: 0.75,
        reason: `Nothing in the task relates to: ${stray.map((i) => i.name).join(', ')}.`,
      };
    }
    return { aligned: true, confidence: 0.7, reason: 'Every item shares terms with the stated task.' };
  }

  async scanUntrusted(text: string): Promise<InjectionFinding> {
    const scan = heuristicInjectionScan(text);
    return { suspicious: scan.suspicious, reason: scan.matches.join('; ') };
  }

  async proposeRemedy(input: {
    diffs: FulfillmentDiff[];
    remainingRefundableMinor: number;
    policyText: string;
  }): Promise<RemedyProposal> {
    const missing = input.diffs.filter((d) => d.shippedQty < d.expectedQty && d.expectedQty > 0);
    const wrongItems = input.diffs.filter((d) => d.expectedQty === 0 && d.shippedQty > 0);
    if (missing.length > 0 && wrongItems.length === 0) {
      const amount = missing.reduce((s, d) => s + (d.expectedQty - d.shippedQty) * d.unitPriceMinor, 0);
      return {
        action: amount >= input.remainingRefundableMinor ? 'full_refund' : 'partial_refund',
        refundAmountMinor: Math.min(amount, input.remainingRefundableMinor),
        rationale: 'Items paid for were not shipped; refund the unshipped value.',
      };
    }
    if (wrongItems.length > 0) {
      return {
        action: 'exchange',
        rationale: 'A different item than the one approved was dispatched; offer an exchange for the approved item.',
      };
    }
    return { action: 'escalate', rationale: 'No clear remedy; route to a human.' };
  }
}
