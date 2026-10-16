import { createHash } from 'node:crypto';
import { canonicalJson } from '../util/canonical.js';

export interface AuditEntry {
  seq: number;
  ts: string;
  type: string;
  data: unknown;
  prevHash: string;
  hash: string;
}

const GENESIS = '0'.repeat(64);

function hashEntry(prevHash: string, seq: number, ts: string, type: string, data: unknown): string {
  return createHash('sha256')
    .update(`${prevHash}|${canonicalJson({ seq, ts, type, data })}`)
    .digest('hex');
}

/**
 * Append-only, hash-chained log. Each entry commits to the one before it, so
 * editing, deleting or reordering any past entry breaks verification.
 *
 * MVP note: this is tamper-EVIDENT, not tamper-proof. Anchoring the head hash
 * somewhere outside the gateway (or signing it) is the production step.
 */
export class AuditLog {
  private chain: AuditEntry[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  append(type: string, data: unknown): AuditEntry {
    const snapshot = JSON.parse(JSON.stringify(data ?? null)) as unknown;
    const seq = this.chain.length;
    const ts = this.now().toISOString();
    const prevHash = seq === 0 ? GENESIS : this.chain[seq - 1]!.hash;
    const entry: AuditEntry = { seq, ts, type, data: snapshot, prevHash, hash: hashEntry(prevHash, seq, ts, type, snapshot) };
    this.chain.push(entry);
    return entry;
  }

  entries(): readonly AuditEntry[] {
    return this.chain;
  }

  head(): string {
    return this.chain.length === 0 ? GENESIS : this.chain[this.chain.length - 1]!.hash;
  }

  verify(): { ok: boolean; length: number; brokenAt?: number } {
    let prev = GENESIS;
    for (const [i, e] of this.chain.entries()) {
      if (e.seq !== i || e.prevHash !== prev || e.hash !== hashEntry(prev, e.seq, e.ts, e.type, e.data)) {
        return { ok: false, length: this.chain.length, brokenAt: i };
      }
      prev = e.hash;
    }
    return { ok: true, length: this.chain.length };
  }
}
