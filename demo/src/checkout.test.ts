import { checkout } from './checkout';

/** A small executable example of checkout's expected result. */
export function verifiesCheckout() {
  const order = checkout([12, 8], 'customer-1');
  if (order.total !== 20) throw new Error('Expected a total of 20');
}
