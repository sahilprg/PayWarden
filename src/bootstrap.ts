import { createAIProvider, type AIProvider } from './ai/index.js';
import { AuditLog } from './audit/chain.js';
import { DemoCatalog, type CatalogPort } from './catalog/catalog.js';
import type { Config } from './config.js';
import { Gateway } from './gateway/gateway.js';
import { MandateSigner } from './mandate/sign.js';
import { PayPalClient } from './paypal/client.js';
import { FakePayPal } from './paypal/fake.js';
import type { PayPalPort } from './paypal/port.js';
import { Store } from './store/store.js';

export interface BootOptions {
  config: Config;
  paypal?: PayPalPort;
  ai?: AIProvider;
  catalog?: CatalogPort;
  now?: () => Date;
  signer?: MandateSigner;
}

/** Assemble a Gateway. Anything not injected is built from config, so tests can swap pieces freely. */
export function createGateway(opts: BootOptions) {
  const { config } = opts;
  const now = opts.now ?? (() => new Date());
  const { clientId, clientSecret, webhookId, baseUrl } = config.paypal;

  let paypalMode: 'sandbox' | 'fake';
  let paypal = opts.paypal;
  if (paypal) {
    paypalMode = paypal instanceof FakePayPal ? 'fake' : 'sandbox';
  } else if (clientId && clientSecret) {
    paypal = new PayPalClient({ clientId, clientSecret, baseUrl, webhookId });
    paypalMode = 'sandbox';
  } else {
    paypal = new FakePayPal();
    paypalMode = 'fake';
  }

  const ai = opts.ai ?? createAIProvider({ anthropic: config.anthropic, openai: config.openai });
  const catalog = opts.catalog ?? new DemoCatalog();
  const store = new Store();
  const audit = new AuditLog(now);
  const signer = opts.signer ?? new MandateSigner(config.signingKeyPem);

  const gateway = new Gateway({
    store,
    audit,
    signer,
    paypal,
    catalog,
    ai,
    now,
    returnUrl: `${config.publicBaseUrl}/checkout/return`,
    cancelUrl: `${config.publicBaseUrl}/checkout/cancel`,
  });
  return { gateway, store, audit, signer, paypal, catalog, ai, paypalMode };
}
