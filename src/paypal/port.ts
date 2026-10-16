export interface OrderLine {
  sku: string;
  name: string;
  category: string;
  unitPriceMinor: number;
  quantity: number;
}

export interface CreateOrderInput {
  /** Sent as the PayPal-Request-Id header so retries cannot create a second order. */
  requestId: string;
  referenceId: string;
  currency: string;
  description: string;
  items: OrderLine[];
  shippingMinor: number;
  taxMinor: number;
  returnUrl: string;
  cancelUrl: string;
}

export interface CreateOrderResult {
  paypalOrderId: string;
  status: string;
  approveUrl?: string;
}

export interface CaptureResult {
  status: string;
  captureId?: string;
  amountMinor?: number;
  currency?: string;
}

export interface RefundInput {
  requestId: string;
  captureId: string;
  amountMinor: number;
  currency: string;
  note?: string;
}

export interface RefundResult {
  refundId: string;
  status: string;
  amountMinor: number;
}

export interface WebhookVerifyInput {
  headers: Record<string, string | undefined>;
  /** The exact bytes PayPal sent. Do not re-serialize parsed JSON. */
  rawBody: string;
}

/** The only surface of PayPal the gateway can touch. Real client and fake both implement it. */
export interface PayPalPort {
  createOrder(input: CreateOrderInput): Promise<CreateOrderResult>;
  captureOrder(paypalOrderId: string, requestId: string): Promise<CaptureResult>;
  refundCapture(input: RefundInput): Promise<RefundResult>;
  verifyWebhook(input: WebhookVerifyInput): Promise<boolean>;
}

export class PayPalError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly debugId?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'PayPalError';
  }
}
