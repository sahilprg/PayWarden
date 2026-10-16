import type {
  DraftMandate,
  InjectionFinding,
  IntentJudgment,
  PaymentProposal,
  RemedyProposal,
} from '../domain/schemas.js';
import type { FulfillmentDiff, Quote } from '../domain/types.js';

/**
 * Everything the AI does in Paywarden, behind one interface.
 *
 * The rule that makes this safe: the AI only ever PROPOSES or TIGHTENS.
 * It cannot approve a payment the policy engine denied, and a failed AI call
 * degrades to "ask a human", never to "allow".
 */
export interface AIProvider {
  readonly name: string;

  /** Turn "max $50 per purchase, no gift cards" into a structured draft mandate. */
  compileMandate(naturalLanguage: string): Promise<DraftMandate>;

  /** Does this catalogue-verified basket plausibly match what the person asked their agent to do? */
  judgeIntent(input: { task: string; proposal: PaymentProposal; quote?: Quote }): Promise<IntentJudgment>;

  /** Look for instructions aimed at an AI agent inside untrusted web/product content. */
  scanUntrusted(text: string): Promise<InjectionFinding>;

  /** Suggest a remedy for a paid-but-wrong order. A human merchant must approve it. */
  proposeRemedy(input: { diffs: FulfillmentDiff[]; remainingRefundableMinor: number; policyText: string }): Promise<RemedyProposal>;
}
