def receipt_line(item, quantity, price):
    """Return a receipt line like '3 x Notebook = Rs 150'."""
    total = quantity * price
    return quantity + " x " + item + " = Rs " + total
