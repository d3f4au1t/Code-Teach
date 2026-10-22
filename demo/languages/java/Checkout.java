package demo;
public class Checkout {
    /** Turns the cart prices into a total for the checkout feature. */
    public static double checkout(double[] prices) {
        return Pricing.total(prices);
    }
}
