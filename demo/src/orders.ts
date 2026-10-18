const orders: { customerId: string; total: number }[] = [];

/** Records an order in this process's memory, and returns the recorded order. */
export function saveOrder(customerId: string, total: number) {
  const order = { customerId, total };
  orders.push(order);
  return order;
}
