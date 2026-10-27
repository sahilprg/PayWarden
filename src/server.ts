import { createApp } from './app.js';
import { createGateway } from './bootstrap.js';
import { loadConfig } from './config.js';
import { FakePayPal } from './paypal/fake.js';
import { FallbackAIProvider } from './ai/fallback.js';
import { HeuristicProvider } from './ai/heuristic.js';
import { Playgrounds } from './playground.js';

const config = loadConfig();
const boot = createGateway({ config });
const app = createApp(
  boot.gateway,
  { agentToken: config.agentToken, ownerToken: config.ownerToken, owners: config.owners, agents: config.agents },
  {
    fake: boot.paypal instanceof FakePayPal ? boot.paypal : undefined,
    // Private visitor playgrounds (offline PayPal, this server's AI). Turn off with PLAYGROUND=0.
    playgrounds:
      process.env['PLAYGROUND'] === '0'
        ? undefined
        : new Playgrounds(new FallbackAIProvider(boot.ai, new HeuristicProvider()), {}, Date.now, {
            trustProxy: Boolean(process.env['RENDER']),
            hsts: process.env['NODE_ENV'] === 'production',
          }),
    trustProxy: Boolean(process.env['RENDER']),
    hsts: process.env['NODE_ENV'] === 'production',
  },
);

app.listen(config.port, () => {
  const line = '─'.repeat(64);
  console.log(line);
  console.log(`Paywarden listening on :${config.port}`);
  console.log(`  Public : ${config.publicBaseUrl}  (console at ${config.publicBaseUrl}/dashboard)`);
  console.log(`  PayPal : ${boot.paypalMode === 'sandbox' ? `SANDBOX (${config.paypal.baseUrl})` : 'FAKE (no PAYPAL_CLIENT_ID/SECRET set, nothing reaches PayPal)'}`);
  console.log(`  AI     : ${boot.ai.name}${config.anthropic.apiKey || config.openai.apiKey ? '' : '  (no AI key set, using the weak offline fallback; set AI_API_KEY or ANTHROPIC_API_KEY)'}`);
  if (config.usingDevTokens) console.log('  WARNING: using built-in dev tokens. Set AGENT_API_TOKEN and OWNER_API_TOKEN.');
  const named = Object.keys(config.owners);
  const bound = Object.keys(config.agents);
  console.log(`  Owners : ${named.length ? `named approvers ${named.join(', ')}` : 'shared owner token only (approver names are marked unverified)'}`);
  if (bound.length) console.log(`  Agents : tokens bound to ${bound.join(', ')}`);
  if (boot.paypalMode === 'sandbox' && !config.paypal.webhookId) console.log('  NOTE   : PAYPAL_WEBHOOK_ID not set, webhooks will be rejected.');
  console.log(line);
});
