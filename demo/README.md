# Checkout demo

The checkout feature accepts a cart at `src/route.ts`, computes a total in the workspace pricing package, and saves an order in memory through `src/orders.ts`. No database or network is involved.

With the extension running, open `src/checkout.ts` and hover `checkout`. Choose **Explain more**, then **Upstream → caller → checkoutRoute**. Use **Back**, then **Downstream → callee → calculateTotal** to cross into the pricing package. Use **Back** again to return to checkout. The test caller provides another path to the same function.

Try adding a comment above `checkout`, or rename the call in `route.ts`: the panel and relationships refresh after edits without saving.
