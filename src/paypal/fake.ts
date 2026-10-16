import {
  PayPalError,
  type CaptureResult,
  type CreateOrderInput,
  type CreateOrderResult,
  type PayPalPort,
  type RefundInput,
  type RefundResult,
  type WebhookVerifyInput,
} from './port.js';

interface FakeOrder {
  id: string;
  totalMinor: number;
  currency: string;
  approved: boolean;
  captureId?: string;
  refundedMinor: number;
}

/**
 * Offline stand-in for PayPal, used by tests, the Adversarial Commerce Lab and
 * `npm start` when no sandbox credentials are set. It mimics the behaviours the
 * gateway relies on, notably PayPal-Request-Id idempotency and the rule that an
 * order cannot be captured until the payer approves it.
 *
 * It is NOT PayPal. Real behaviour must be verified against the sandbox.
 */
export class FakePayPal implements PayPalPort {
  readonly orders = new Map<string, FakeOrder>();
  /** Counts of real "side effects", so tests can prove retries did not duplicate money movement. */
  readonly calls = { createOrder: 0, capture: 0, refund: 0 };

  private seq = 0;
  private createdByRequest = new Map<string, CreateOrderResult>();
  private capturedByRequest = new Map<string, CaptureResult>();
  private refundedByRequest = new Map<string, RefundResult>();

  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    const prior = this.createdByRequest.get(input.requestId);
    if (prior) return prior;
    this.calls.createOrder++;
    const itemTotal = input.items.reduce((s, i) => s + i.unitPriceMinor * i.quantity, 0);
    const id = `FAKE-ORDER-${++this.seq}`;
    this.orders.set(id, {
      id,
      totalMinor: itemTotal + input.shippingMinor + input.taxMinor,
      currency: input.currency,
      approved: false,
      refundedMinor: 0,
    });
    const result = {
      paypalOrderId: id,
      status: 'PAYER_ACTION_REQUIRED',
      approveUrl: `https://sandbox.example.invalid/checkout?token=${id}`,
    };
    this.createdByRequest.set(input.requestId, result);
    return result;
  }

  /** Test/lab helper: pretend the human payer approved the order in PayPal checkout. */
  simulatePayerApproval(paypalOrderId: string): void {
    const o = this.orders.get(paypalOrderId);
    if (o) o.approved = true;
  }

  async captureOrder(paypalOrderId: string, requestId: string): Promise<CaptureResult> {
    const prior = this.capturedByRequest.get(requestId);
    if (prior) return prior;
    const o = this.orders.get(paypalOrderId);
    if (!o) throw new PayPalError('Order not found', 404);
    if (!o.approved) throw new PayPalError('ORDER_NOT_APPROVED', 422);
    this.calls.capture++;
    o.captureId = `FAKE-CAP-${++this.seq}`;
    const result = { status: 'COMPLETED', captureId: o.captureId, amountMinor: o.totalMinor, currency: o.currency };
    this.capturedByRequest.set(requestId, result);
    return result;
  }

  async refundCapture(input: RefundInput): Promise<RefundResult> {
    const prior = this.refundedByRequest.get(input.requestId);
    if (prior) return prior;
    const o = [...this.orders.values()].find((x) => x.captureId === input.captureId);
    if (!o) throw new PayPalError('Capture not found', 404);
    if (o.refundedMinor + input.amountMinor > o.totalMinor) throw new PayPalError('REFUND_AMOUNT_EXCEEDED', 422);
    this.calls.refund++;
    o.refundedMinor += input.amountMinor;
    const result = { refundId: `FAKE-REFUND-${++this.seq}`, status: 'COMPLETED', amountMinor: input.amountMinor };
    this.refundedByRequest.set(input.requestId, result);
    return result;
  }

  async verifyWebhook({ headers }: WebhookVerifyInput): Promise<boolean> {
    return headers['x-fake-signature'] === 'valid';
  }
}
