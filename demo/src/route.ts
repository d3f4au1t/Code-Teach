import { checkout } from './checkout';

/** Handles the checkout feature's incoming request. */
export function checkoutRoute(request: { prices: number[]; customerId: string }) {
  return checkout(request.prices, request.customerId);
}
