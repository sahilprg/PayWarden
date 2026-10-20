export interface Config {
  port: number;
  publicBaseUrl: string;
  paypal: { clientId?: string; clientSecret?: string; webhookId?: string; baseUrl: string };
  anthropic: { apiKey?: string; model: string };
  openai: { apiKey?: string; baseUrl: string; model: string };
  agentToken: string;
  ownerToken: string;
  signingKeyPem?: string;
  usingDevTokens: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const baseUrl = (env['PAYPAL_BASE_URL'] ?? 'https://api-m.sandbox.paypal.com').replace(/\/$/, '');
  // Hackathon safety rail: refuse to talk to live PayPal unless someone says so on purpose.
  if (!baseUrl.includes('sandbox') && env['ALLOW_LIVE'] !== '1') {
    throw new Error(`Refusing to start: PAYPAL_BASE_URL (${baseUrl}) is not a sandbox URL. Set ALLOW_LIVE=1 only if you really mean it.`);
  }

  const agentToken = env['AGENT_API_TOKEN'];
  const ownerToken = env['OWNER_API_TOKEN'];
  const usingDevTokens = !agentToken || !ownerToken;
  if (usingDevTokens && env['NODE_ENV'] === 'production') {
    throw new Error('AGENT_API_TOKEN and OWNER_API_TOKEN must be set in production.');
  }
  const port = Number(env['PORT'] ?? 3000);

  return {
    port,
    // On Render, RENDER_EXTERNAL_URL is the service's public https address.
    publicBaseUrl: (env['PUBLIC_BASE_URL'] || env['RENDER_EXTERNAL_URL'] || `http://localhost:${port}`).replace(/\/$/, ''),
    paypal: {
      clientId: env['PAYPAL_CLIENT_ID'] || undefined,
      clientSecret: env['PAYPAL_CLIENT_SECRET'] || undefined,
      webhookId: env['PAYPAL_WEBHOOK_ID'] || undefined,
      baseUrl,
    },
    anthropic: { apiKey: env['ANTHROPIC_API_KEY'] || undefined, model: env['ANTHROPIC_MODEL'] || 'claude-sonnet-5-5' },
    openai: {
      apiKey: env['AI_API_KEY'] || undefined,
      baseUrl: (env['AI_BASE_URL'] || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/$/, ''),
      model: env['AI_MODEL'] || 'gemini-3-flash-preview,gemini-3.1-flash-lite-preview,gemini-3.8-flash',
    },
    agentToken: agentToken ?? 'dev-agent-token',
    ownerToken: ownerToken ?? 'dev-owner-token',
    signingKeyPem: env['MANDATE_SIGNING_KEY_PEM']?.replace(/\\n/g, '\n') || undefined,
    usingDevTokens,
  };
}
