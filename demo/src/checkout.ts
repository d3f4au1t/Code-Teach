import { calculateTotal } from '@demo/pricing';
import { saveOrder } from './orders';

/** Converts a cart into a saved order. Called by the checkout route. */
export function checkout(prices: number[], customerId: string) {
  const total = calculateTotal(prices);
  return saveOrder(customerId, total);
}
