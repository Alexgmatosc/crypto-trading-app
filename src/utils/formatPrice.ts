/**
 * Dynamic decimal formatter for crypto asset prices.
 * Sub-dollar altcoins (e.g. DOGE/USDT) preserve 5 decimals; major assets (>= $1) use 2 decimals.
 */
export function formatPrice(price: number): number {
  return Math.abs(price) < 1 ? Number(price.toFixed(5)) : Number(price.toFixed(2));
}
