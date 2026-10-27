import { randomBytes, randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { AIBudget, BudgetedAIProvider } from './ai/budget.js';
import { HeuristicProvider } from './ai/heuristic.js';
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
  /** New playgrounds across all visitors per hour. */
  createdPerHour: number;
  /** Scenario runs per playground (each run makes several AI calls). */
  scenarioRunsEach: number;
  /** Scenario runs across all playgrounds per hour. */
  scenarioRunsPerHour: number;
  /** Single trial purchases per playground. */
  attemptsEach: number;
  /** Live AI calls per playground; after that it answers with the offline rules. */
  aiCallsEach: number;
  /** Live AI calls across all playgrounds per hour (protects the owner's AI quota). */
  aiCallsPerHour: number;
  /** Requests that change state (anything but GET) per playground, which bounds its memory. */
  writesEach: number;
}

const DEFAULT_LIMITS: PlaygroundLimits = {
  maxActive: 100,
  idleMs: 60 * 60_000,
  perIpPerHour: 6,
  createdPerHour: 300,
  scenarioRunsEach: 3,
  scenarioRunsPerHour: 60,
  attemptsEach: 25,
  aiCallsEach: 40,
  aiCallsPerHour: 400,
  writesEach: 300,
};

interface Playground {
  id: string;
  ownerToken: string;
  handler: RequestHandler;
  lastUsed: number;
  writes: number;
  scenarioRuns: number;
  attempts: number;
}

/**
 * Private, throwaway Paywarden instances for visitors (for example hackathon judges).
 * Each has its own gateway, store, audit log, signing key and tokens, and the offline PayPal
 * fake (nothing reaches PayPal). They share the server's AI within a budget, so visitors
 * cannot run up the owner's bill. Nothing a visitor does can touch the real instance or
 * anyone else's playground.
 */
export class Playgrounds {
  private readonly items = new Map<string, Playground>();
  private readonly createdByIp = new Map<string, number[]>();
  private created: number[] = [];
  private scenarioRuns: number[] = [];
  private readonly limits: PlaygroundLimits;
  private readonly aiBudget: AIBudget;
  private readonly offline = new HeuristicProvider();

  constructor(
    private readonly ai: AIProvider,
    limits: Partial<PlaygroundLimits> = {},
    private readonly clock: () => number = Date.now,
    private readonly appOptions: { trustProxy?: boolean; hsts?: boolean } = {},
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.aiBudget = new AIBudget(this.limits.aiCallsPerHour, clock);
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
    for (const [ip, times] of this.createdByIp) {
      const recent = times.filter((t) => now - t < 3_600_000);
      if (recent.length) this.createdByIp.set(ip, recent);
      else this.createdByIp.delete(ip);
    }
  }

  /** Returns undefined when this address, or everyone together, has made too many playgrounds this hour. */
  create(ip: string): { id: string; ownerToken: string; idleMinutes: number } | undefined {
    const now = this.clock();
    this.created = this.created.filter((t) => now - t < 3_600_000);
    const recent = (this.createdByIp.get(ip) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= this.limits.perIpPerHour || this.created.length >= this.limits.createdPerHour) return undefined;
    recent.push(now);
    this.createdByIp.set(ip, recent);
    this.created.push(now);
    this.sweep();

    const id = randomUUID();
    const ownerToken = randomBytes(24).toString('base64url');
    const agentToken = randomBytes(24).toString('base64url');
    const fake = new FakePayPal();
    const ai = new BudgetedAIProvider(this.ai, this.offline, this.aiBudget, this.limits.aiCallsEach);
    const boot = createGateway({ config: loadConfig({}), paypal: fake, ai });
    const pg: Playground = { id, ownerToken, handler: () => undefined, lastUsed: now, writes: 0, scenarioRuns: 0, attempts: 0 };
    const app = createApp(boot.gateway, { agentToken, ownerToken }, {
      fake,
      scenarioGate: () => this.allowScenario(pg),
      attemptGate: () => this.allowAttempt(pg),
      trustProxy: this.appOptions.trustProxy,
      hsts: this.appOptions.hsts,
    });
    pg.handler = (req, res, next) => app(req, res, next);
    this.items.set(id, pg);
    return { id, ownerToken, idleMinutes: Math.round(this.limits.idleMs / 60_000) };
  }

  private allowAttempt(pg: Playground): string | undefined {
    if (pg.attempts >= this.limits.attemptsEach) return 'That is enough tries for one playground. Start a new playground to keep going.';
    pg.attempts += 1;
    return undefined;
  }

  private allowScenario(pg: Playground): string | undefined {
    const now = this.clock();
    this.scenarioRuns = this.scenarioRuns.filter((t) => now - t < 3_600_000);
    if (this.scenarioRuns.length >= this.limits.scenarioRunsPerHour) return 'The demo has run a lot this hour. Try again in a few minutes.';
    if (pg.scenarioRuns >= this.limits.scenarioRunsEach) return `This playground has run the scenario ${pg.scenarioRuns} times. Start a new playground to run it again.`;
    pg.scenarioRuns += 1;
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
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        if (p.writes >= this.limits.writesEach) {
          res.status(429).json({ error: 'PLAYGROUND_FULL', message: 'This playground has done all it can. Start a new one to keep going.' });
          return;
        }
        p.writes += 1;
      }
      p.lastUsed = this.clock();
      p.handler(req, res, next);
    };
  }
}
