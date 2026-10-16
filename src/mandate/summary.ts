import type { DraftMandate } from '../domain/schemas.js';
import { formatMoney } from '../util/money.js';

/**
 * Plain-English readback of a draft mandate, rendered by CODE from the
 * structured values. The person confirms this text, so an LLM must never be
 * the one writing it: a model could describe a mandate more kindly than it is.
 */
export function summarizeMandate(d: DraftMandate): string[] {
  const money = (n: number) => formatMoney(n, d.currency);
  return [
    `Spend at most ${money(d.perPurchaseLimitMinor)} on any single purchase.`,
    `Spend at most ${money(d.periodLimitMinor)} in total over any ${d.periodDays}-day window.`,
    d.approvalThresholdMinor < d.perPurchaseLimitMinor
      ? `Ask you first for any purchase above ${money(d.approvalThresholdMinor)}.`
      : `Never ask for approval under the limit; anything above ${money(d.perPurchaseLimitMinor)} is refused outright.`,
    d.allowedMerchants.length
      ? `Only buy from: ${d.allowedMerchants.join(', ')}.`
      : 'May buy from any merchant.',
    d.deniedCategories.length
      ? `Never buy these categories: ${d.deniedCategories.join(', ')}.`
      : 'No product categories are blocked.',
    d.requireQuote
      ? 'Every purchase must match a quote you approved (items, quantities and a maximum total).'
      : 'Purchases do not need a pre-approved quote.',
    `This mandate expires in ${d.expiresInHours} hour(s).`,
  ];
}
