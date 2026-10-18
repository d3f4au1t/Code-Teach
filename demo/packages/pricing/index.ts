/** Adds the item prices; this demo has no tax or discount rules. */
export function calculateTotal(prices: number[]): number {
  return prices.reduce((sum, price) => sum + price, 0);
}
