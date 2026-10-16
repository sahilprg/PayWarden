import { describe, expect, it } from 'vitest';
import { AuditLog } from '../src/audit/chain.js';

function filled(n = 4) {
  const log = new AuditLog(() => new Date('2026-10-20T10:00:00Z'));
  for (let i = 0; i < n; i++) log.append('EVENT', { i, note: `entry ${i}` });
  return log;
}

describe('AuditLog', () => {
  it('verifies an intact chain and links entries by hash', () => {
    const log = filled();
    expect(log.verify()).toEqual({ ok: true, length: 4 });
    const e = log.entries();
    expect(e[1]!.prevHash).toBe(e[0]!.hash);
    expect(log.head()).toBe(e[3]!.hash);
  });

  it('an empty log verifies and has a fixed genesis head', () => {
    const log = new AuditLog();
    expect(log.verify()).toEqual({ ok: true, length: 0 });
    expect(log.head()).toBe('0'.repeat(64));
  });

  it('detects an edited entry and says where', () => {
    const log = filled();
    (log.entries()[2]!.data as { note: string }).note = 'rewritten history';
    expect(log.verify()).toMatchObject({ ok: false, brokenAt: 2 });
  });

  it('detects a deleted entry', () => {
    const log = filled();
    (log.entries() as unknown as unknown[]).splice(1, 1);
    expect(log.verify().ok).toBe(false);
  });

  it('detects reordered entries', () => {
    const log = filled();
    const arr = log.entries() as unknown as unknown[];
    [arr[1], arr[2]] = [arr[2], arr[1]];
    expect(log.verify().ok).toBe(false);
  });

  it('detects a recomputed tail that no longer matches the previous hash', () => {
    const log = filled();
    const last = log.entries()[3]!;
    (last as { prevHash: string }).prevHash = 'f'.repeat(64);
    expect(log.verify()).toMatchObject({ ok: false, brokenAt: 3 });
  });

  it('snapshots data at append time, so later mutation of the original cannot rewrite history', () => {
    const log = new AuditLog();
    const data = { amount: 100 };
    log.append('PAY', data);
    data.amount = 1;
    expect((log.entries()[0]!.data as { amount: number }).amount).toBe(100);
    expect(log.verify().ok).toBe(true);
  });
});
