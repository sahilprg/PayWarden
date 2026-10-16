import type { SignedMandate } from '../domain/schemas.js';
import type { ApprovalRecord, AuthorizationResult, ExceptionRecord, OrderRecord, Quote } from '../domain/types.js';

export interface LedgerEntry {
  mandateId: string;
  orderId: string;
  amountMinor: number;
  ts: string;
}

/**
 * In-memory state for the MVP. Swap this class for a database-backed
 * implementation (same shape) for anything beyond a demo.
 */
export class Store {
  mandates = new Map<string, SignedMandate>();
  revoked = new Set<string>();
  quotes = new Map<string, Quote>();
  decisions = new Map<string, { proposalHash: string; result: AuthorizationResult }>();
  approvals = new Map<string, ApprovalRecord>();
  orders = new Map<string, OrderRecord>();
  ordersByPaypalId = new Map<string, string>();
  exceptions = new Map<string, ExceptionRecord>();
  ledger: LedgerEntry[] = [];
  webhookEvents = new Set<string>();
  killSwitch = false;

  /**
   * Spend counted against a mandate's rolling window. Amounts are reserved when
   * an order is created. Refunds deliberately do NOT give allowance back: the
   * conservative choice for an agent that must not exceed its budget.
   */
  spentInWindow(mandateId: string, now: Date, days: number): number {
    const since = now.getTime() - days * 86_400_000;
    return this.ledger
      .filter((l) => l.mandateId === mandateId && Date.parse(l.ts) >= since)
      .reduce((sum, l) => sum + l.amountMinor, 0);
  }

  releaseReservation(orderId: string): void {
    this.ledger = this.ledger.filter((l) => l.orderId !== orderId);
  }
}
