"""utils/billitem_tax (same rules as siri-api/billitem_tax.py): the tax rate of a bill line AT THE SALE.
Run from the backend folder:  .venv\Scripts\python.exe -m unittest tests.test_billitem_tax -v
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from utils import billitem_tax as bt  # noqa: E402


def line(price, tax_now, saved=None, qty=1):
    return {"price": price, "quantity": qty, "saved_tax": saved, "current_tax": tax_now}


class _Table:
    def __init__(self, owner):
        self.owner = owner

    def insert(self, rows):
        self.owner.attempts.append(rows)
        self.rows = rows
        return self

    def execute(self):
        if self.owner.no_column and any("tax_percentage" in r for r in self.rows):
            raise Exception("Could not find the 'tax_percentage' column of 'billitems' in the schema cache (PGRST204)")
        return self


class _Client:
    def __init__(self, no_column):
        self.no_column = no_column
        self.attempts = []

    def table(self, _name):
        return _Table(self)


class SaleTaxTests(unittest.TestCase):
    def test_the_ballari_chain_billed_before_it_had_a_tax_gets_0_percent(self):
        bill = {"total": 1215, "discount_percentage": 10, "discount_amount": 132.82}
        self.assertEqual(bt.sale_taxes(bill, [line(600, 3), line(728.16, 3)]), [0.0, 3])

    def test_a_correct_bill_keeps_todays_rates_even_with_rounding(self):
        self.assertEqual(bt.sale_taxes({"total": 1215, "discount_percentage": 10}, [line(582.52, 3), line(728.16, 3)]), [3, 3])
        self.assertEqual(bt.sale_taxes({"total": 1220, "discount_percentage": 10}, [line(582.52, 3), line(728.16, 3)]), [3, 3])

    def test_saved_rate_wins_and_fallbacks(self):
        self.assertEqual(bt.sale_taxes({"total": 1}, [line(600, 3, saved=18)]), [18.0])
        self.assertEqual(bt.sale_taxes({"total": 550, "discount_amount": 50}, [line(600, 3)]), [0.0])
        self.assertEqual(bt.sale_taxes({"total": 99999}, [line(600, 3)]), [3])
        self.assertEqual(bt.sale_taxes({}, [line(600, 3)]), [3])

    def test_only_the_line_that_explains_the_gap_is_changed(self):
        self.assertEqual(bt.sale_taxes({"total": 1309}, [line(1000, 3), line(200, 3), line(100, 3)]), [0.0, 3, 3])


class InsertTests(unittest.TestCase):
    def test_saved_with_the_rate_when_the_column_exists(self):
        db = _Client(no_column=False)
        bt.insert_billitems([{"billid": "B", "price": 1, "tax_percentage": 3}], db)
        self.assertEqual(db.attempts, [[{"billid": "B", "price": 1, "tax_percentage": 3}]])

    def test_before_the_migration_still_saved_without_it(self):
        db = _Client(no_column=True)
        bt.insert_billitems([{"billid": "B", "price": 1, "tax_percentage": 3}], db)
        self.assertEqual(db.attempts[-1], [{"billid": "B", "price": 1}])


if __name__ == "__main__":
    unittest.main()
