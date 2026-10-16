/**
 * All amounts inside Paywarden are integers in minor units (cents).
 * Only two-decimal currencies are supported, which avoids zero-decimal
 * (JPY) and three-decimal currency pitfalls in the MVP.
 */
export const SUPPORTED_CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD'] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

export function minorToDecimal(minor: number): string {
  if (!Number.isSafeInteger(minor) || minor < 0) {
    throw new RangeError(`Invalid minor-unit amount: ${minor}`);
  }
  const whole = Math.floor(minor / 100);
  const frac = minor % 100;
  return `${whole}.${frac.toString().padStart(2, '0')}`;
}

export function decimalToMinor(value: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) {
    throw new RangeError(`Invalid decimal amount: ${value}`);
  }
  const [whole = '0', frac = ''] = value.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

export function formatMoney(minor: number, currency: string): string {
  return `${currency} ${minorToDecimal(minor)}`;
}
