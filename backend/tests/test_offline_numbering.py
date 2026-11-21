"""Bill numbers handed out OFFLINE must continue after today's bills saved ONLINE through siri-api.

Found on the Mypadu test store (2026-11-21): an online bill INV-MPD-...0001 went through siri-api, the internet dropped,
and the next (offline) bill was numbered ...0001 again, because siri-api bills were never added to the PC's local bill
list. siri-api then saved it as ...0002, so the customer's receipt showed another bill's number.
Run from the backend folder:  .venv\Scripts\python.exe -m unittest tests.test_offline_numbering -v
"""
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from utils import offline_bill_queue as q  # noqa: E402


class OfflineNumberingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="numbering-")
        for name in ("BILLS_FILE", "BILL_ITEMS_FILE"):
            if hasattr(q, name):
                p = mock.patch.object(q, name, os.path.join(self.tmp, name.lower() + ".json"))
                p.start()
                self.addCleanup(p.stop)
        p = mock.patch.object(q, "_get_store_code_from_local", return_value="MPD")
        p.start()
        self.addCleanup(p.stop)
        self.prefix = q._today_invoice_prefix("MPD")

    def payload(self):
        return {"store_id": "s1", "total_amount": 45, "items": [{"product_id": "p1", "quantity": 1, "unit_price": 42.86}]}

    def test_an_online_bill_is_counted_by_the_next_offline_number(self):
        self.assertEqual(q._next_offline_invoice_id([], "s1"), f"{self.prefix}0001")
        q.remember_bill_locally("u1", self.payload(), f"{self.prefix}0001")            # saved online via siri-api
        self.assertEqual(q._next_offline_invoice_id([], "s1"), f"{self.prefix}0002")

    def test_remembering_twice_keeps_one_row_and_never_raises(self):
        q.remember_bill_locally("u1", self.payload(), f"{self.prefix}0005")
        q.remember_bill_locally("u1", self.payload(), f"{self.prefix}0005")
        q.remember_bill_locally("u1", self.payload(), "")                              # nothing to remember
        rows = [b for b in q.read_json_file(q.BILLS_FILE, []) if b.get("id") == f"{self.prefix}0005"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(q._next_offline_invoice_id([], "s1"), f"{self.prefix}0006")


if __name__ == "__main__":
    unittest.main()
