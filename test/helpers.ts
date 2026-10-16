import { HeuristicProvider } from '../src/ai/heuristic.js';
import type { AIProvider } from '../src/ai/provider.js';
import { createGateway } from '../src/bootstrap.js';
import { DemoCatalog } from '../src/catalog/catalog.js';
import { loadConfig } from '../src/config.js';
import type { PaymentProposal } from '../src/domain/schemas.js';
import { FakePayPal } from '../src/paypal/fake.js';

export const MERCHANT = DemoCatalog.MERCHANT_ID;

export const NL =
  'Buy a 65W USB-C charger with a UK plug. Max $60 per purchase, $200 per month. ' +
  'No gift cards. Only buy from Fernlight Electronics. Ask me for approval above $50. Expires in 3 days.';

export async function makeEnv(opts: { nl?: string; ai?: AIProvider; paypal?: FakePayPal } = {}) {
  const clock = { t: Date.parse('2026-10-20T10:00:00Z') };
  const now = () => new Date(clock.t);
  const fake = opts.paypal ?? new FakePayPal();
  const catalog = new DemoCatalog();
  const boot = createGateway({
    config: loadConfig({}),
    paypal: fake,
    ai: opts.ai ?? new HeuristicProvider(),
    catalog,
    now,
  });
  const { draft } = await boot.gateway.compileMandate(opts.nl ?? NL);
  const mandate = boot.gateway.activateMandate({ draft, subject: 'test-user', agentId: 'test-agent' });
  return { ...boot, fake, catalog, clock, mandate, mandateId: mandate.body.id };
}
export type Env = Awaited<ReturnType<typeof makeEnv>>;

export const claim = (env: Env, sku: string, quantity = 1) => {
  const c = env.catalog.lookup(MERCHANT, sku)!;
  return { sku, name: c.name, category: c.category, unitPriceMinor: c.unitPriceMinor, quantity };
};

let seq = 0;
export function proposal(env: Env, o: Partial<PaymentProposal> & { items: PaymentProposal['items'] }): PaymentProposal {
  return {
    idempotencyKey: `test-key-${++seq}-${Math.random().toString(36).slice(2, 10)}`,
    mandateId: env.mandateId,
    agentId: 'test-agent',
    merchantId: MERCHANT,
    shippingMinor: 600,
    taxMinor: 0,
    currency: 'USD',
    description: 'Charger',
    ...o,
  };
}

export function quote(env: Env, items: { sku: string; quantity: number }[], maxTotalMinor = 5000) {
  return env.gateway.approveQuote({ mandateId: env.mandateId, merchantId: MERCHANT, items, maxTotalMinor, approvedBy: 'test-user' });
}

/** Convenience: one quote + one authorize for a single charger. */
export async function buyCharger(env: Env, extra: Partial<PaymentProposal> = {}) {
  const q = quote(env, [{ sku: 'charger-65w-uk', quantity: 1 }]);
  return env.gateway.authorize(proposal(env, { quoteId: q.id, items: [claim(env, 'charger-65w-uk')], ...extra }));
}

export class StubAI extends HeuristicProvider {
  judged = 0;
  scanned = 0;
  constructor(private readonly overrides: Partial<Pick<AIProvider, 'judgeIntent' | 'scanUntrusted' | 'proposeRemedy'>> = {}) {
    super();
  }
  override async judgeIntent(...args: Parameters<AIProvider['judgeIntent']>) {
    this.judged++;
    return this.overrides.judgeIntent ? this.overrides.judgeIntent(...args) : super.judgeIntent(...args);
  }
  override async scanUntrusted(...args: Parameters<AIProvider['scanUntrusted']>) {
    this.scanned++;
    return this.overrides.scanUntrusted ? this.overrides.scanUntrusted(...args) : super.scanUntrusted(...args);
  }
  override async proposeRemedy(...args: Parameters<AIProvider['proposeRemedy']>) {
    return this.overrides.proposeRemedy ? this.overrides.proposeRemedy(...args) : super.proposeRemedy(...args);
  }
}
