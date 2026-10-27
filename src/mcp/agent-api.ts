import { PaymentProposalSchema, type PaymentProposal } from '../domain/schemas.js';
import type { AuthorizationResult, OrderRecord } from '../domain/types.js';
import { GatewayError, type Gateway } from '../gateway/gateway.js';

type Permits = ReturnType<Gateway['agentPermits']>;
type Catalog = ReturnType<Gateway['catalog']>;

/**
 * Everything the MCP tools can do, and nothing more: the agent's powers.
 * There is deliberately no approve, refund, revoke or freeze here.
 */
export interface AgentApi {
  permits(agentId?: string): Promise<Permits>;
  catalog(merchantId?: string): Promise<Catalog>;
  authorize(proposal: PaymentProposal): Promise<AuthorizationResult>;
  getOrder(orderId: string): Promise<OrderRecord>;
  capture(orderId: string): Promise<OrderRecord>;
}

/** Talks to a running Paywarden server with the AGENT token (used by `npm run mcp`). */
export class HttpAgentApi implements AgentApi {
  constructor(
    private readonly baseUrl: string,
    private readonly agentToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown, okStatuses: number[] = [200]): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.agentToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(90_000),
      });
    } catch (e) {
      const why = e instanceof Error && e.name === 'TimeoutError' ? 'did not answer within 90 seconds' : 'could not be reached';
      throw new Error(`Paywarden at ${this.baseUrl} ${why}. Check PAYWARDEN_URL and that the server is running (a sleeping free host can take a minute to wake).`);
    }
    const json = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    if (res.status === 401) throw new Error('Paywarden rejected the agent token. Set AGENT_API_TOKEN to the server\'s agent token (not the owner token).');
    if (!okStatuses.includes(res.status)) throw new Error(json.message ?? `Paywarden returned HTTP ${res.status} (${json.error ?? 'error'}).`);
    return json as T;
  }

  async permits(agentId?: string) {
    const q = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
    return (await this.call<{ permits: Permits }>('GET', `/v1/agent/permits${q}`)).permits;
  }
  async catalog(merchantId?: string) {
    const q = merchantId ? `?merchantId=${encodeURIComponent(merchantId)}` : '';
    return (await this.call<{ merchants: Catalog }>('GET', `/v1/catalog${q}`)).merchants;
  }
  authorize(proposal: PaymentProposal) {
    // 403 (refused) and 502 (PayPal failed) still carry a full decision the agent should read.
    return this.call<AuthorizationResult>('POST', '/v1/payments/authorize', proposal, [200, 403, 502]);
  }
  getOrder(orderId: string) {
    return this.call<OrderRecord>('GET', `/v1/orders/${encodeURIComponent(orderId)}`);
  }
  capture(orderId: string) {
    return this.call<OrderRecord>('POST', `/v1/orders/${encodeURIComponent(orderId)}/capture`);
  }
}

/**
 * Calls the gateway directly; used by the hosted /mcp endpoint, which sits behind the agent token.
 * When the token is bound to one agent, every call is held to that agent's permits and orders.
 */
export class InProcessAgentApi implements AgentApi {
  constructor(
    private readonly gateway: Gateway,
    private readonly boundAgentId?: string,
  ) {}
  private ownOrder(orderId: string) {
    const order = this.gateway.getOrder(orderId);
    if (this.boundAgentId && order.proposal.agentId !== this.boundAgentId) throw new GatewayError('ORDER_NOT_FOUND', 'No such order.', 404);
    return order;
  }
  async permits(agentId?: string) {
    return this.gateway.agentPermits(this.boundAgentId ?? agentId);
  }
  async catalog(merchantId?: string) {
    return this.gateway.catalog(merchantId);
  }
  authorize(proposal: PaymentProposal) {
    const p = PaymentProposalSchema.parse(proposal);
    if (this.boundAgentId && p.agentId !== this.boundAgentId) {
      return Promise.reject(new GatewayError('AGENT_TOKEN_MISMATCH', `This token belongs to agent "${this.boundAgentId}".`, 403));
    }
    return this.gateway.authorize(p);
  }
  async getOrder(orderId: string) {
    return this.ownOrder(orderId);
  }
  capture(orderId: string) {
    return this.gateway.capture(this.ownOrder(orderId).id);
  }
}

export { GatewayError };
