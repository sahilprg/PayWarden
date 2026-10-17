import { createApp } from './app.js';
import { createGateway } from './bootstrap.js';
import { loadConfig } from './config.js';
import { FakePayPal } from './paypal/fake.js';

const config = loadConfig();
const boot = createGateway({ config });
const app = createApp(
  boot.gateway,
  { agentToken: config.agentToken, ownerToken: config.ownerToken },
  { fake: boot.paypal instanceof FakePayPal ? boot.paypal : undefined },
);

app.listen(config.port, () => {
  const line = '─'.repeat(64);
  console.log(line);
  console.log(`Paywarden listening on :${config.port}`);
  console.log(`  PayPal : ${boot.paypalMode === 'sandbox' ? `SANDBOX (${config.paypal.baseUrl})` : 'FAKE (no PAYPAL_CLIENT_ID/SECRET set, nothing reaches PayPal)'}`);
  console.log(`  AI     : ${boot.ai.name}${config.anthropic.apiKey || config.openai.apiKey ? '' : '  (no AI key set, using the weak offline fallback; set AI_API_KEY or ANTHROPIC_API_KEY)'}`);
  if (config.usingDevTokens) console.log('  WARNING: using built-in dev tokens. Set AGENT_API_TOKEN and OWNER_API_TOKEN.');
  if (boot.paypalMode === 'sandbox' && !config.paypal.webhookId) console.log('  NOTE   : PAYPAL_WEBHOOK_ID not set, webhooks will be rejected.');
  console.log(line);
});
