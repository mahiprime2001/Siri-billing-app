"""
Bills the app gave up on only because the internet was down (the pre-22-July bug) are put back in the
queue and delivered; bills given up for real reasons are left alone; nothing is ever deleted or sent twice.

Run from the backend folder:   .venv\\Scripts\\python.exe -m unittest tests.test_quarantine_recovery -v
"""
import json
import os
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND not in sys.path:
    sys.path.insert(0, BACKEND)

from helpers.utils import read_json_file  # noqa: E402
from utils import offline_bill_queue as obq  # noqa: E402
from utils import quarantine_recovery as qr  # noqa: E402
from utils.queue_common import poison_file_for  # noqa: E402

OLD_REASON = "Supabase client unavailable"


def poisoned(n, reason=OLD_REASON, **extra):
    return {
        "queue_id": f"Q-{n}", "type": "create_bill", "user_id": "user-1",
        "client_request_id": None, "forced_bill_id": f"INV-TST-1207202600{n:02d}",
        "payload": {"store_id": "s1", "total_amount": 100.0 + n, "items": [{"product_id": "p1", "quantity": 1}],
                    "_forced_bill_id": f"INV-TST-1207202600{n:02d}"},
        "attempts": 5, "last_error": reason, "created_at": "2026-07-12T11:20:00+00:00",
        "updated_at": "2026-07-12T11:20:00+00:00", "quarantined_at": "2026-07-12T11:21:00+00:00",
        "quarantine_reason": reason, **extra,
    }


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="quarantine-recovery-test-")
        self.queue = os.path.join(self.dir, "offline_bill_queue.json")
        self.poison = poison_file_for(self.queue)
        self.events = []
        self.online = SimpleNamespace(is_offline_fallback=False)
        self.in_db = {}  # bill_id -> row, the fake database
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(qr, "OFFLINE_BILL_QUEUE_FILE", self.queue).start()
        mock.patch.object(obq, "OFFLINE_BILL_QUEUE_FILE", self.queue).start()
        mock.patch.object(qr, "log_offline_event", lambda event, **f: self.events.append((event, f))).start()
        mock.patch.object(obq, "log_offline_event", lambda event, **f: None).start()
        mock.patch.object(qr, "get_supabase_client", lambda: self.online).start()
        mock.patch.object(qr, "_fetch_existing_bill_by_id", lambda client, bid: self.in_db.get(bid)).start()

    def write(self, path, data):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f)

    def read(self, path):
        return read_json_file(path, [])


class RecoveryRules(Base):
    def test_a_bill_given_up_over_connectivity_goes_back_in_the_queue(self):
        self.write(self.poison, [poisoned(6)])
        result = qr.recover_quarantined_bills()
        self.assertEqual(result["requeued"], 1)
        live = self.read(self.queue)
        self.assertEqual([q["forced_bill_id"] for q in live], ["INV-TST-120720260006"])
        self.assertEqual(self.read(self.poison), [])          # no longer put aside
        item = live[0]
        self.assertEqual((item["attempts"], item["last_error"], item["consecutive_permanent_failures"]), (0, None, 0))
        self.assertNotIn("quarantine_reason", item)
        self.assertEqual(item["recovery_count"], 1)
        self.assertEqual([e[0] for e in self.events], ["quarantine_requeued"])

    def test_the_original_sale_time_is_kept_not_replaced_by_now(self):
        self.write(self.poison, [poisoned(6)])
        qr.recover_quarantined_bills()
        self.assertEqual(self.read(self.queue)[0]["payload"]["timestamp"], "2026-07-12T11:20:00+00:00")

    def test_an_explicit_sale_time_in_the_bill_is_never_overwritten(self):
        item = poisoned(6)
        item["payload"]["timestamp"] = "2026-07-12T16:55:00"
        self.write(self.poison, [item])
        qr.recover_quarantined_bills()
        self.assertEqual(self.read(self.queue)[0]["payload"]["timestamp"], "2026-07-12T16:55:00")

    def test_a_bill_that_is_already_in_the_database_is_just_cleared(self):
        item = poisoned(6)
        self.in_db[item["forced_bill_id"]] = {"id": item["forced_bill_id"], "total": 106.0, "userid": "user-1",
                                              "customerid": "walkin"}
        with mock.patch.object(qr, "_payload_matches_existing_bill", return_value=True):
            self.write(self.poison, [item])
            result = qr.recover_quarantined_bills()
        self.assertEqual((result["already_delivered"], result["requeued"]), (1, 0))
        self.assertEqual(self.read(self.queue), [])
        self.assertEqual(self.read(self.poison), [])
        self.assertEqual([e[0] for e in self.events], ["quarantine_already_delivered"])

    def test_a_different_bill_with_the_same_number_is_not_mistaken_for_it(self):
        item = poisoned(6)
        self.in_db[item["forced_bill_id"]] = {"id": item["forced_bill_id"], "total": 999.0}
        with mock.patch.object(qr, "_payload_matches_existing_bill", return_value=False):
            self.write(self.poison, [item])
            result = qr.recover_quarantined_bills()
        self.assertEqual((result["already_delivered"], result["requeued"]), (0, 1))   # goes back; replay decides

    def test_bills_given_up_for_real_reasons_are_left_alone(self):
        real = poisoned(7, reason='duplicate key value violates unique constraint "bills_pkey"')
        self.write(self.poison, [real])
        result = qr.recover_quarantined_bills()
        self.assertEqual((result["requeued"], result["left_alone"]), (0, 1))
        self.assertEqual(self.read(self.poison), [real])
        self.assertEqual(self.read(self.queue), [])

    def test_only_the_eligible_ones_move_when_the_file_has_both(self):
        real = poisoned(7, reason="insufficient stock for product p1")
        self.write(self.poison, [poisoned(6), real, poisoned(8, reason="[Errno 11001] getaddrinfo failed")])
        result = qr.recover_quarantined_bills()
        self.assertEqual(result["requeued"], 2)
        self.assertEqual([p["queue_id"] for p in self.read(self.poison)], ["Q-7"])

    def test_still_offline_means_wait_and_change_nothing(self):
        self.online.is_offline_fallback = True
        self.write(self.poison, [poisoned(6)])
        result = qr.recover_quarantined_bills()
        self.assertEqual((result["waiting"], result["requeued"]), (1, 0))
        self.assertEqual(len(self.read(self.poison)), 1)

    def test_running_twice_never_duplicates_a_bill(self):
        self.write(self.poison, [poisoned(6)])
        qr.recover_quarantined_bills()
        qr.recover_quarantined_bills()
        self.assertEqual(len(self.read(self.queue)), 1)
        # simulate being cut off between the two writes: the bill is in BOTH files
        self.write(self.poison, [poisoned(6)])
        qr.recover_quarantined_bills()
        self.assertEqual(len(self.read(self.queue)), 1)
        self.assertEqual(self.read(self.poison), [])

    def test_a_bill_cannot_loop_forever(self):
        self.write(self.poison, [poisoned(6, recovery_count=qr.MAX_RECOVERIES_PER_BILL)])
        result = qr.recover_quarantined_bills()
        self.assertEqual(result["requeued"], 0)
        self.assertEqual(len(self.read(self.poison)), 1)

    def test_other_kinds_of_queue_items_are_not_touched(self):
        other = poisoned(6)
        other["type"] = "something_else"
        self.write(self.poison, [other])
        self.assertEqual(qr.recover_quarantined_bills()["requeued"], 0)

    def test_an_empty_or_missing_poison_file_costs_nothing(self):
        self.assertEqual(qr.recover_quarantined_bills(), {"checked": 0, "already_delivered": 0, "requeued": 0,
                                                          "left_alone": 0, "waiting": 0})
        self.write(self.poison, [])
        self.assertEqual(qr.recover_quarantined_bills()["checked"], 0)

    def test_the_other_queue_contents_are_preserved_when_a_bill_is_added(self):
        existing = {"queue_id": "Q-live", "type": "create_bill", "forced_bill_id": "INV-TST-999", "payload": {}}
        self.write(self.queue, [existing])
        self.write(self.poison, [poisoned(6)])
        qr.recover_quarantined_bills()
        self.assertEqual([q["queue_id"] for q in self.read(self.queue)], ["Q-live", "Q-6"])


class EndToEnd(Base):
    def test_given_up_bill_is_delivered_by_the_real_replay_with_its_original_number_and_time(self):
        sent = []

        def fake_create_bill_transaction(current_user_id, data, forced_bill_id=None):
            sent.append((current_user_id, forced_bill_id, data.get("timestamp")))

        self.write(self.poison, [poisoned(6), poisoned(9)])
        mock.patch.object(obq, "create_bill_transaction", fake_create_bill_transaction).start()
        mock.patch.object(obq, "get_supabase_client", lambda: self.online).start()

        qr.recover_quarantined_bills()
        result = obq.process_offline_bill_queue(max_items=25)

        self.assertEqual((result["succeeded"], result["quarantined"], result["remaining"]), (2, 0, 0))
        self.assertEqual(sorted(s[1] for s in sent), ["INV-TST-120720260006", "INV-TST-120720260009"])
        self.assertTrue(all(s[0] == "user-1" and s[2] == "2026-07-12T11:20:00+00:00" for s in sent))
        self.assertEqual(self.read(self.queue), [])
        self.assertEqual(self.read(self.poison), [])

    def test_if_the_replay_fails_for_a_real_reason_the_bill_returns_to_the_poison_file_with_that_reason(self):
        def refuse(current_user_id, data, forced_bill_id=None):
            raise ValueError("Insufficient stock for product p1")

        self.write(self.poison, [poisoned(6)])
        mock.patch.object(obq, "create_bill_transaction", refuse).start()
        mock.patch.object(obq, "get_supabase_client", lambda: self.online).start()

        qr.recover_quarantined_bills()
        for _ in range(6):               # five real failures in a row put it aside again
            obq.process_offline_bill_queue(max_items=25)

        back = self.read(self.poison)
        self.assertEqual(len(back), 1)
        self.assertIn("Insufficient stock", back[0]["quarantine_reason"])
        self.assertEqual(self.read(self.queue), [])
        # and the recovery does not drag it back out again: the reason is a real one
        self.assertEqual(qr.recover_quarantined_bills()["requeued"], 0)


class ClassifierTests(unittest.TestCase):
    def test_a_failed_address_lookup_is_a_connection_problem_not_a_data_problem(self):
        from utils.queue_common import classify_error
        self.assertEqual(classify_error("[Errno 11001] getaddrinfo failed"), "transient")
        self.assertEqual(classify_error(OSError(11001, "getaddrinfo failed")), "transient")
        # real data problems are still permanent
        self.assertEqual(classify_error("duplicate key value violates unique constraint"), "permanent")
        self.assertEqual(classify_error("insufficient stock for product p1"), "permanent")


if __name__ == "__main__":
    unittest.main()
