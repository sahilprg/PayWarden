import type { PaymentProposal, RemedyProposal } from './schemas.js';

export type Verdict = 'allow' | 'deny' | 'needs_approval';

export interface Reason {
  code: string;
  message: string;
  /** Who raised it. Policy and catalog reasons are deterministic; AI reasons can only tighten. */
  source: 'policy' | 'catalog' | 'ai';
}

export interface Decision {
  verdict: Verdict;
  reasons: Reason[];
  totalMinor: number;
}

export interface Quote {
  id: string;
  mandateId: string;
  merchantId: string;
  items: { sku: string; quantity: number }[];
  maxTotalMinor: number;
  approvedBy: string;
  createdAt: string;
  /** Quotes are single-use: once an order is created from one, it cannot back another payment. */
  consumedByOrderId?: string;
}

export type OrderStatus = 'created' | 'approved' | 'captured' | 'refunded_partial' | 'refunded';

export interface OrderRecord {
  id: string;
  mandateId: string;
  merchantId: string;
  /** The catalogue-verified proposal, not the raw agent claim. */
  proposal: PaymentProposal;
  totalMinor: number;
  currency: string;
  paypalOrderId: string;
  approveUrl?: string;
  status: OrderStatus;
  captureId?: string;
  capturedMinor?: number;
  refundedMinor: number;
  refundCount: number;
  createdAt: string;
}

export interface ApprovalRecord {
  id: string;
  proposalHash: string;
  proposal: PaymentProposal;
  decision: Decision;
  status: 'pending' | 'approved' | 'rejected';
  requestedAt: string;
  resolvedBy?: string;
  resolvedAt?: string;
}

export interface FulfillmentDiff {
  sku: string;
  expectedQty: number;
  shippedQty: number;
  unitPriceMinor: number;
}

export interface ExceptionRecord {
  id: string;
  orderId: string;
  type: 'FULFILLMENT_MISMATCH';
  diffs: FulfillmentDiff[];
  proposedRemedy?: RemedyProposal;
  status: 'open' | 'resolved';
  resolution?: { action: string; approvedBy: string; refundedMinor?: number; at: string };
  createdAt: string;
}

export interface AuthorizationResult {
  status: 'order_created' | 'denied' | 'pending_approval' | 'failed';
  decision: Decision;
  orderId?: string;
  paypalOrderId?: string;
  /** Where the *human payer* approves the PayPal order. The agent never completes this step. */
  approveUrl?: string;
  approvalId?: string;
  replayed?: boolean;
  error?: string;
}
