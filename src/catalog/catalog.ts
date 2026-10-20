export interface CatalogItem {
  sku: string;
  name: string;
  category: string;
  unitPriceMinor: number;
  currency: string;
}

/**
 * The merchant's source of truth. The gateway trusts this, never the agent,
 * for prices, categories and shipping. Plug in a real catalogue by
 * implementing this interface.
 */
export interface CatalogPort {
  lookup(merchantId: string, sku: string): CatalogItem | undefined;
  shippingMinor(merchantId: string, currency: string, items: { sku: string; quantity: number }[]): number;
  taxMinor(merchantId: string, currency: string, items: { sku: string; quantity: number }[]): number;
  /** Optional browsing support for agents: merchants and their items. */
  merchants?(): string[];
  list?(merchantId: string): CatalogItem[];
}

/** A tiny fictional store used for the demo and the Adversarial Commerce Lab. */
export class DemoCatalog implements CatalogPort {
  static readonly MERCHANT_ID = 'fernlight-electronics';

  private items = new Map<string, CatalogItem>();
  private shipping = 600;

  constructor() {
    const seed: Omit<CatalogItem, 'currency'>[] = [
      { sku: 'charger-65w-uk', name: '65W USB-C GaN charger, UK plug', category: 'electronics', unitPriceMinor: 3400 },
      { sku: 'charger-65w-eu', name: '65W USB-C GaN charger, EU plug', category: 'electronics', unitPriceMinor: 3400 },
      { sku: 'charger-30w-uk', name: '30W USB-C charger, UK plug', category: 'electronics', unitPriceMinor: 1900 },
      { sku: 'cable-usbc-2m', name: 'USB-C cable, 2 metres', category: 'electronics', unitPriceMinor: 900 },
      { sku: 'giftcard-200', name: 'Fernlight store gift card 200', category: 'gift_card', unitPriceMinor: 20000 },
    ];
    for (const s of seed) this.items.set(s.sku, { ...s, currency: 'USD' });
  }

  lookup(merchantId: string, sku: string): CatalogItem | undefined {
    return merchantId === DemoCatalog.MERCHANT_ID ? this.items.get(sku) : undefined;
  }

  merchants(): string[] {
    return [DemoCatalog.MERCHANT_ID];
  }

  list(merchantId: string): CatalogItem[] {
    return merchantId === DemoCatalog.MERCHANT_ID ? [...this.items.values()] : [];
  }

  shippingMinor(): number {
    return this.shipping;
  }

  taxMinor(): number {
    return 0;
  }

  /** Lab helpers: let a scenario change what the merchant charges. */
  setShipping(minor: number): void {
    this.shipping = minor;
  }

  setPrice(sku: string, minor: number): void {
    const item = this.items.get(sku);
    if (item) this.items.set(sku, { ...item, unitPriceMinor: minor });
  }
}
