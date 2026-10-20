import { randomBytes, randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { AIProvider } from './ai/provider.js';
import { createApp } from './app.js';
import { createGateway } from './bootstrap.js';
import { loadConfig } from './config.js';
import { FakePayPal } from './paypal/fake.js';

export interface PlaygroundLimits {
  /** Playgrounds alive at once; the least recently used one is dropped beyond this. */
  maxActive: number;
  /** A playground is dropped after this long without requests. */
  idleMs: number;
  /** New playgrounds per client IP per hour. */
  perIpPerHour: number;
  /** Scenario runs per playground (each run makes several AI calls). */
  scenarioRunsEach: number;
  /** Scenario runs across all playgrounds per hour, to protect the AI quota. */
  scenarioRunsPerHour: number;
}

const DEFAULT_LIMITS: PlaygroundLimits = { maxActive: 40, idleMs: 60 * 60_000, perIpPerHour: 6, scenarioRunsEach: 3, scenarioRunsPerHour: 60 };

interface Playground {
  id: string;
  ownerToken: string;
  handler: RequestHandler;
  lastUsed: number;
}

/**
 * Private, throwaway Paywarden instances for visitors (for example hackathon judges).
 * Each has its own gateway, store, audit log, signing key and tokens, the offline PayPal
 * fake (nothing reaches PayPal), and the server's AI provider. Nothing a visitor does
 * there can touch the real instance or anyone else's playground.
 */
export class Playgrounds {
  private readonly items = new Map<string, Playground>();
  private readonly createdByIp = new Map<string, number[]>();
  private scenarioRuns: number[] = [];
  private readonly limits: PlaygroundLimits;

  constructor(
    private readonly ai: AIProvider,
    limits: Partial<PlaygroundLimits> = {},
    private readonly clock: () => number = Date.now,
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  get size() {
    return this.items.size;
  }

  private sweep() {
    const now = this.clock();
    for (const [id, p] of this.items) if (now - p.lastUsed > this.limits.idleMs) this.items.delete(id);
    while (this.items.size >= this.limits.maxActive) {
      const oldest = [...this.items.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!oldest) break;
      this.items.delete(oldest.id);
    }
  }

  /** Returns undefined when this IP has made too many playgrounds this hour. */
  create(ip: string): { id: string; ownerToken: string; idleMinutes: number } | undefined {
    const now = this.clock();
    const recent = (this.createdByIp.get(ip) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= this.limits.perIpPerHour) return undefined;
    recent.push(now);
    this.createdByIp.set(ip, recent);
    this.sweep();

    const id = randomUUID();
    const ownerToken = randomBytes(24).toString('base64url');
    const agentToken = randomBytes(24).toString('base64url');
    const fake = new FakePayPal();
    const boot = createGateway({ config: loadConfig({}), paypal: fake, ai: this.ai });
    const app = createApp(boot.gateway, { agentToken, ownerToken }, { fake, scenarioGate: () => this.allowScenario(id) });
    const handler: RequestHandler = (req, res, next) => app(req, res, next);
    this.items.set(id, { id, ownerToken, handler, lastUsed: now });
    return { id, ownerToken, idleMinutes: Math.round(this.limits.idleMs / 60_000) };
  }

  private readonly runsById = new Map<string, number>();
  private allowScenario(id: string): string | undefined {
    const now = this.clock();
    this.scenarioRuns = this.scenarioRuns.filter((t) => now - t < 3_600_000);
    if (this.scenarioRuns.length >= this.limits.scenarioRunsPerHour) return 'The demo has run a lot this hour. Try again in a few minutes.';
    const mine = this.runsById.get(id) ?? 0;
    if (mine >= this.limits.scenarioRunsEach) return `This playground has run the scenario ${mine} times. Start a new playground to run it again.`;
    this.runsById.set(id, mine + 1);
    this.scenarioRuns.push(now);
    return undefined;
  }

  /** Express handler mounted at /play/:pid. */
  route(): RequestHandler {
    return (req, res, next) => {
      const id = String(req.params['pid'] ?? '');
      const p = this.items.get(id);
      if (!p || this.clock() - p.lastUsed > this.limits.idleMs) {
        this.items.delete(id);
        res.status(404).json({ error: 'PLAYGROUND_GONE', message: 'This playground has expired. Start a new one.' });
        return;
      }
      p.lastUsed = this.clock();
      p.handler(req, res, next);
    };
  }
}
