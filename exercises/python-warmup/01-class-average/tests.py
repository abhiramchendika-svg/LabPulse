from solution import average


def test_simple_average():
    result = average([70, 80, 90])
    assert result == 80.0, f"average([70, 80, 90]) should be 80.0, got {result!r}"


def test_rounds_to_two_places():
    result = average([1, 2, 2])
    assert result == 1.67, f"average([1, 2, 2]) should be 1.67, got {result!r}"


def test_empty_list():
    result = average([])
    assert result == 0.0, f"average([]) should be 0.0, got {result!r}"
