from pricing import total

def checkout(prices: list[float], customer_id: str = "guest") -> float:
    """Calculate the amount charged for this customer's cart."""
    return total(prices)
