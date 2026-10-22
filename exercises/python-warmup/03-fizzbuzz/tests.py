from solution import fizzbuzz


def test_first_five():
    result = fizzbuzz(5)
    expected = ["1", "2", "Fizz", "4", "Buzz"]
    assert result == expected, f"fizzbuzz(5) should be {expected}, got {result!r}"


def test_fifteen_is_fizzbuzz():
    result = fizzbuzz(15)
    assert len(result) == 15, f"fizzbuzz(15) should have 15 items, got {len(result)}"
    assert result[-1] == "FizzBuzz", f"the 15th item should be 'FizzBuzz', got {result[-1]!r}"


def test_numbers_are_strings():
    result = fizzbuzz(7)
    assert len(result) == 7, f"fizzbuzz(7) should have 7 items, got {len(result)}"
    assert result[6] == "7", f"the 7th item should be the string '7', got {result[6]!r}"


def test_zero():
    result = fizzbuzz(0)
    assert result == [], f"fizzbuzz(0) should be an empty list, got {result!r}"
