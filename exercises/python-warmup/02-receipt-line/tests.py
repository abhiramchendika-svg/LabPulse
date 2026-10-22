from solution import receipt_line


def test_several_items():
    result = receipt_line("Notebook", 3, 50)
    assert result == "3 x Notebook = Rs 150", f'expected "3 x Notebook = Rs 150", got {result!r}'


def test_single_item():
    result = receipt_line("Pen", 1, 10)
    assert result == "1 x Pen = Rs 10", f'expected "1 x Pen = Rs 10", got {result!r}'


def test_zero_quantity():
    result = receipt_line("Eraser", 0, 5)
    assert result == "0 x Eraser = Rs 0", f'expected "0 x Eraser = Rs 0", got {result!r}'
