import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

export type Role = 'owner' | 'agent';

/**
 * Who a request is acting as.
 * - owner with `name`: a named approver whose name comes from their own token (verified).
 * - owner without `name`: the shared owner token; any name it gives is only a claim.
 * - agent with `agentId`: an agent token bound to one agent; it can only act for that agent.
 * - agent without `agentId`: the shared agent token (any agent id).
 */
export interface Identity {
  role: Role;
  name?: string;
  agentId?: string;
}

interface Credential {
  token: Buffer;
  identity: Identity;
}

export interface AuthConfig {
  /** Shared agent token (unbound). */
  agentToken: string;
  /** Shared owner token (unnamed). */
  ownerToken: string;
  /** Named owner tokens: approver name -> token. */
  owners?: Record<string, string>;
  /** Agent tokens bound to one agent id: agent id -> token. */
  agents?: Record<string, string>;
}

function same(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function bearer(req: Request): string {
  const h = req.header('authorization') ?? '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

/** Checks a presented token against every credential (constant time per comparison, no early exit). */
export class Credentials {
  private readonly list: Credential[] = [];

  constructor(cfg: AuthConfig) {
    const add = (token: string | undefined, identity: Identity) => {
      if (token) this.list.push({ token: Buffer.from(token), identity });
    };
    add(cfg.ownerToken, { role: 'owner' });
    add(cfg.agentToken, { role: 'agent' });
    for (const [name, token] of Object.entries(cfg.owners ?? {})) add(token, { role: 'owner', name });
    for (const [agentId, token] of Object.entries(cfg.agents ?? {})) add(token, { role: 'agent', agentId });
  }

  identify(token: string): Identity | undefined {
    if (!token) return undefined;
    const presented = Buffer.from(token);
    let found: Identity | undefined;
    for (const c of this.list) if (same(presented, c.token) && !found) found = c.identity;
    return found;
  }
}

/**
 * The name recorded for an owner action. A named token's own name always wins; with the
 * shared token the typed name is kept but marked as unverified, so the audit log never
 * presents a claim as proof.
 */
export function actorName(identity: Identity | undefined, typed: string | undefined): string {
  if (identity?.role === 'owner' && identity.name) return identity.name;
  const claimed = (typed ?? '').trim() || 'owner';
  return `${claimed} (unverified)`;
}

/** Parses "name=token,name2=token2" (tokens may themselves contain "="). */
export function parseTokenMap(raw: string | undefined, label: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const part of raw.split(',').map((p) => p.trim()).filter(Boolean)) {
    const i = part.indexOf('=');
    const name = i > 0 ? part.slice(0, i).trim() : '';
    const token = i > 0 ? part.slice(i + 1).trim() : '';
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new Error(`${label}: "${name || part}" is not a valid name (letters, digits, . _ - only).`);
    if (token.length < 24) throw new Error(`${label}: the token for "${name}" is too short (use at least 24 random characters).`);
    if (out[name]) throw new Error(`${label}: "${name}" appears twice.`);
    out[name] = token;
  }
  return out;
}
