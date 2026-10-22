package demo;
public class Pricing {
    /** Adds the listed prices; this example has no tax or discount. */
    public static double total(double[] prices) {
        double sum = 0;
        for (double price : prices) { sum += price; }
        return sum;
    }
}
