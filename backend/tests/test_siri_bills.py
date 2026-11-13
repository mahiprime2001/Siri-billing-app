"""
Bills through siri-api AND the offline queue at once. The promise being tested: a sale is never lost and never
made twice, whatever mix of online / offline / "the answer got lost" happens.

A fake siri-api answers (httpx.MockTransport); the old database path and the queue's files are replaced by
fakes / temp files. Nothing touches the network or real data.
Run from the backend folder:   .venv\\Scripts\\python.exe -m unittest tests.test_siri_bills -v
"""
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

import httpx

BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND not in sys.path:
    sys.path.insert(0, BACKEND)

from tests.test_siri_api import LOGIN_OK, FakeSiri, switches_body  # noqa: E402

from services import siri_bills  # noqa: E402
from services.siri_bills import SiriBillRefused, SiriBillUnsure, SiriReplayError  # noqa: E402
from utils import offline_bill_queue, queue_common, siri_api  # noqa: E402
from utils.siri_api import SiriApi  # noqa: E402

SALE = {"store_id": "s1", "items": [{"product_id": "p1", "quantity": 2, "unit_price": 75.0}], "total_amount": 150.0}
CREATED = (201, {"message": "Bill created successfully", "bill_id": "INV-KNL-130620260001", "bill": {"id": "INV-KNL-130620260001"},
                 "items_created": 1, "total_amount": 150.0, "replacements_created": 0,
                 "item_snapshots": [{"productid": "p1", "quantity": 2, "price": 75.0, "total": 150.0, "name": "Ring"}]})


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="siri-bills-test-")
        self.siri = FakeSiri()
        self.now = [1000.0]
        os.environ.pop("SIRI_API_DISABLE", None)
        self.api = SiriApi(base_url="https://siri.test", data_dir=self.dir, transport=self.siri.transport(), clock=lambda: self.now[0])
        siri_api._client = self.api
        self.siri.routes[("POST", "/api/auth/login")] = LOGIN_OK
        self.siri.routes[("GET", "/api/store/config")] = switches_body(bills_write=True)
        self.patches = [
            mock.patch("utils.bill_item_snapshot.replace_bill_item_snapshots"),
            mock.patch("utils.stock_stream.publish"),
            mock.patch("utils.products_cache.invalidate_products_cache_for_store"),
            mock.patch("services.siri_bills._min_serial_hint", return_value=0),
            mock.patch("utils.queue_common.log_offline_event"),
        ]
        self.snap, self.publish, self.cache, self.hint, self.event = [p.start() for p in self.patches]

    def tearDown(self):
        for p in self.patches:
            p.stop()
        siri_api._client = None
        os.environ.pop("SIRI_API_DISABLE", None)

    def login(self):
        self.assertTrue(self.api.login("a@x.com", "pw"))

    def calls(self, method, path):
        return [c for c in self.siri.calls if c.method == method and c.url.path == path]


# ---------------------------------------------------------------- the online attempt

class OnlineAttemptTests(Base):
    def test_with_the_switch_off_or_no_session_or_another_cashier_siri_api_is_not_used(self):
        data = dict(SALE)
        self.assertIsNone(siri_bills.attempt_online_bill("cashier-1", data))                 # no session
        self.login()
        self.siri.routes[("GET", "/api/store/config")] = switches_body(bills_write=False)
        self.assertIsNone(siri_bills.attempt_online_bill("cashier-1", data))                 # switch off
        self.now[0] += 125
        self.siri.routes[("GET", "/api/store/config")] = switches_body(bills_write=True)
        self.assertIsNone(siri_bills.attempt_online_bill("cashier-2", data))                 # another cashier
        self.assertEqual(self.calls("POST", "/api/store/bills"), [])
        self.assertNotIn("_client_request_id", data)                                          # nothing was touched

    def test_a_created_bill_comes_back_in_the_shape_the_screens_know_with_the_local_follow_ups_done(self):
        self.login()
        self.siri.routes[("POST", "/api/store/bills")] = CREATED
        data = dict(SALE)
        out = siri_bills.attempt_online_bill("cashier-1", data)
        self.assertEqual((out["queued"], out["bill_id"], out["items_created"], out["via"]), (False, "INV-KNL-130620260001", 1, "siri-api"))
        self.assertTrue(data["_client_request_id"].startswith("pc-"))                         # a request id was made and kept
        sent = json.loads(self.calls("POST", "/api/store/bills")[0].content)
        self.assertEqual(sent["_client_request_id"], data["_client_request_id"])
        self.assertEqual(self.calls("POST", "/api/store/bills")[0].headers["authorization"], "Bearer tok-1")
        self.snap.assert_called_once()                                                        # receipt detail saved on the PC
        self.assertEqual(self.snap.call_args[0][0], "INV-KNL-130620260001")
        self.publish.assert_called_once()
        self.cache.assert_called_once_with("s1")

    def test_a_request_id_from_the_screen_is_kept(self):
        self.login()
        self.siri.routes[("POST", "/api/store/bills")] = CREATED
        data = dict(SALE, _client_request_id="screen-77")
        siri_bills.attempt_online_bill("cashier-1", data)
        self.assertEqual(json.loads(self.calls("POST", "/api/store/bills")[0].content)["_client_request_id"], "screen-77")

    def test_the_offline_queues_highest_number_is_sent_so_numbers_never_clash(self):
        self.login()
        self.siri.routes[("POST", "/api/store/bills")] = CREATED
        self.hint.return_value = 5
        siri_bills.attempt_online_bill("cashier-1", dict(SALE))
        self.assertEqual(json.loads(self.calls("POST", "/api/store/bills")[0].content)["_min_serial"], 5)
        self.hint.return_value = 0
        siri_bills.attempt_online_bill("cashier-1", dict(SALE))
        self.assertNotIn("_min_serial", json.loads(self.calls("POST", "/api/store/bills")[1].content))

    def test_a_repeat_of_the_same_sale_returns_the_bill_already_made(self):
        self.login()
        self.siri.routes[("POST", "/api/store/bills")] = (200, {**CREATED[1], "idempotent_replay": True})
        out = siri_bills.attempt_online_bill("cashier-1", dict(SALE, _client_request_id="r1"))
        self.assertTrue(out["idempotent_replay"])

    def test_a_final_no_from_siri_api_is_raised_with_its_reason_and_nothing_else_happens(self):
        self.login()
        for status, body in ((400, {"message": "Insufficient stock", "code": "insufficient_stock", "retryable": False}),
                             (423, {"error": "billing_paused", "message": "An audit is in progress", "since": "x"}),
                             (403, {"message": "That store is not assigned to this login"}),
                             (409, {"message": "conflict"})):
            self.siri.routes[("POST", "/api/store/bills")] = (status, body)
            with self.assertRaises(SiriBillRefused) as ctx:
                siri_bills.attempt_online_bill("cashier-1", dict(SALE, _client_request_id="rx"))
            self.assertEqual((ctx.exception.status, ctx.exception.body), (status, body))
        self.assertEqual(self.calls("GET", "/api/store/bills/by-request/rx"), [])           # no "did it get through?" check
        self.snap.assert_not_called()

    def test_a_refused_token_means_siri_api_never_saw_the_sale_so_the_old_path_runs(self):
        self.login()
        self.siri.routes[("POST", "/api/store/bills")] = (401, {"error": "expired"})
        self.assertIsNone(siri_bills.attempt_online_bill("cashier-1", dict(SALE)))

    def test_a_lost_answer_is_checked_by_request_id_and_found(self):
        self.login()
        self.siri.routes[("POST", "/api/store/bills")] = (503, {"retryable": True})
        self.siri.routes[("GET", "/api/store/bills/by-request/r2")] = (200, {"found": True, "bill_id": "INV-KNL-130620260009",
                                                                             "bill": {"id": "INV-KNL-130620260009"}})
        out = siri_bills.attempt_online_bill("cashier-1", dict(SALE, _client_request_id="r2"))
        self.assertEqual((out["queued"], out["bill_id"]), (False, "INV-KNL-130620260009"))
        self.assertTrue(out["idempotent_replay"])

    def test_a_lost_answer_that_cannot_be_confirmed_is_unsure_and_keeps_its_request_id(self):
        self.login()
        data = dict(SALE, _client_request_id="r3")
        for create_answer in ((503, {"retryable": True}), (500, {"message": "boom", "retryable": True}), (502, {})):
            self.siri.routes[("POST", "/api/store/bills")] = create_answer
            self.siri.routes[("GET", "/api/store/bills/by-request/r3")] = (200, {"found": False})
            with self.assertRaises(SiriBillUnsure):
                siri_bills.attempt_online_bill("cashier-1", data)
        self.assertEqual(data["_client_request_id"], "r3")
        self.siri.fail = httpx.ReadTimeout("slow")                                           # now the network dies for both calls
        with self.assertRaises(SiriBillUnsure):
            siri_bills.attempt_online_bill("cashier-1", data)


# ---------------------------------------------------------------- the replay (queued sale -> siri-api)

def queued(user="cashier-1", unsure=False, **extra):
    item = {"queue_id": "Q-1", "type": "create_bill", "user_id": user, "client_request_id": "r9",
            "forced_bill_id": "INV-KNL-130620260004", "payload": {**SALE, "_forced_bill_id": "INV-KNL-130620260004"},
            "attempts": 0, **extra}
    if unsure:
        item["siri_unsure"] = True
    return item


class ReplayTests(Base):
    def test_not_used_when_the_switch_is_off_or_this_cashier_has_no_replay_pass(self):
        self.login()
        self.assertIsNone(siri_bills.replay_queued_bill(queued(user="someone-else")))       # no pass for them
        self.siri.routes[("GET", "/api/store/config")] = switches_body(bills_write=False)
        self.now[0] += 125
        self.assertIsNone(siri_bills.replay_queued_bill(queued()))
        self.assertEqual(self.calls("POST", "/api/store/replay/bills"), [])

    def test_a_queued_sale_is_sent_with_the_cashiers_own_pass_its_number_and_its_request_id(self):
        self.login()
        self.siri.routes[("POST", "/api/store/replay/bills")] = (201, {"bill_id": "INV-KNL-130620260004"})
        out = siri_bills.replay_queued_bill(queued())
        self.assertEqual(out, {"bill_id": "INV-KNL-130620260004", "idempotent": False})
        sent = self.calls("POST", "/api/store/replay/bills")[0]
        self.assertEqual(sent.headers["authorization"], "Bearer replay-s1")
        body = json.loads(sent.content)
        self.assertEqual((body["forced_bill_id"], body["_client_request_id"]), ("INV-KNL-130620260004", "r9"))

    def test_it_works_with_nobody_logged_in(self):
        self.login()
        self.siri.routes[("POST", "/api/store/replay/bills")] = (201, {"bill_id": "INV-KNL-130620260004"})
        self.api.switches()                                                                  # the switches are known
        self.api.drop_access_token()                                                         # the cashier logged out
        self.assertIsNotNone(siri_bills.replay_queued_bill(queued()))

    def test_when_the_server_had_the_sale_under_another_number_it_is_flagged_and_still_a_success(self):
        self.login()
        self.siri.routes[("POST", "/api/store/replay/bills")] = (200, {"bill_id": "INV-KNL-130620260001", "idempotent_replay": True})
        out = siri_bills.replay_queued_bill(queued())
        self.assertEqual((out["bill_id"], out["idempotent"]), ("INV-KNL-130620260001", True))
        self.assertEqual(self.event.call_args[0][0], "bill_number_differs")

    def test_a_refused_replay_pass_means_the_old_path_until_the_next_login(self):
        self.login()
        self.siri.routes[("POST", "/api/store/replay/bills")] = (401, {"error": "pass_revoked"})
        self.assertIsNone(siri_bills.replay_queued_bill(queued()))
        before = len(self.siri.calls)
        self.assertIsNone(siri_bills.replay_queued_bill(queued()))                           # the pass was forgotten
        self.assertEqual(len(self.siri.calls), before)

    def test_no_answer_or_a_server_fault_is_retry_for_ever(self):
        self.login()
        for answer in ((500, {}), (502, {}), (503, {"retryable": True})):
            self.siri.routes[("POST", "/api/store/replay/bills")] = answer
            with self.assertRaises(SiriReplayError) as ctx:
                siri_bills.replay_queued_bill(queued())
            self.assertIs(ctx.exception.siri_retryable, True, answer)
        self.siri.fail = httpx.ConnectError("down")
        with self.assertRaises(SiriReplayError) as ctx:
            siri_bills.replay_queued_bill(queued())
        self.assertIs(ctx.exception.siri_retryable, True)

    def test_siri_apis_own_verdict_decides_retry_or_final(self):
        self.login()
        for status, body, expect in ((400, {"message": "no stock", "code": "insufficient_stock", "retryable": False}, False),
                                     (400, {"message": "x", "retryable": True}, True),
                                     (404, {"message": "gone"}, False),
                                     (409, {"message": "number taken"}, False)):
            self.siri.routes[("POST", "/api/store/replay/bills")] = (status, body)
            with self.assertRaises(SiriReplayError) as ctx:
                siri_bills.replay_queued_bill(queued())
            self.assertIs(ctx.exception.siri_retryable, expect, (status, body))


# ---------------------------------------------------------------- the queue worker

class QueueWorkerTests(Base):
    def setUp(self):
        super().setUp()
        self.login()
        self.old_path = mock.patch("utils.offline_bill_queue.create_bill_transaction")
        self.old = self.old_path.start()

    def tearDown(self):
        self.old_path.stop()
        super().tearDown()

    def run_item(self, item):
        return offline_bill_queue._replay_one(item)

    def test_siri_api_takes_the_sale_and_the_old_path_is_not_used(self):
        self.siri.routes[("POST", "/api/store/replay/bills")] = (201, {"bill_id": "INV-KNL-130620260004"})
        status, _item, reason = self.run_item(queued())
        self.assertEqual((status, reason), ("success", None))
        self.old.assert_not_called()

    def test_not_used_for_this_sale_the_old_path_delivers_it(self):
        status, _item, _ = self.run_item(queued(user="someone-else"))                        # no pass for them
        self.assertEqual(status, "success")
        self.old.assert_called_once()
        self.assertEqual(self.old.call_args.kwargs["forced_bill_id"], "INV-KNL-130620260004")

    def test_siri_api_down_a_normal_queued_sale_falls_back_to_the_old_path(self):
        self.siri.routes[("POST", "/api/store/replay/bills")] = (503, {"retryable": True})
        status, _item, _ = self.run_item(queued())
        self.assertEqual(status, "success")
        self.old.assert_called_once()

    def test_an_unsure_sale_waits_for_siri_api_and_is_never_sent_the_old_way(self):
        self.siri.routes[("POST", "/api/store/replay/bills")] = (503, {"retryable": True})
        status, item, _ = self.run_item(queued(unsure=True))
        self.assertEqual((status, item["last_error_class"], item["consecutive_permanent_failures"]), ("retry", "transient", 0))
        self.old.assert_not_called()
        status, item, _ = self.run_item(queued(user="someone-else", unsure=True))            # no pass either: still waits
        self.assertEqual((status, item["last_error_class"]), ("retry", "transient"))
        self.old.assert_not_called()

    def test_a_final_answer_from_siri_api_counts_toward_giving_up_and_the_old_path_is_not_tried(self):
        self.siri.routes[("POST", "/api/store/replay/bills")] = (400, {"message": "no stock", "code": "insufficient_stock", "retryable": False})
        item = queued()
        for n in range(1, queue_common.MAX_PERMANENT_ATTEMPTS):
            status, item, _ = self.run_item(item)
            self.assertEqual((status, item["last_error_class"], item["consecutive_permanent_failures"]), ("retry", "permanent", n))
        status, item, _ = self.run_item(item)
        self.assertEqual(status, "poison")
        self.old.assert_not_called()

    def test_a_retryable_verdict_never_counts_toward_giving_up_however_it_is_worded(self):
        self.siri.routes[("POST", "/api/store/replay/bills")] = (400, {"message": "validation error: constraint", "retryable": True})
        item = queued(unsure=True)                       # a sale that must wait for siri-api (no old-path fallback)
        for _ in range(queue_common.MAX_PERMANENT_ATTEMPTS + 3):
            status, item, _ = self.run_item(item)
            self.assertEqual((status, item["last_error_class"]), ("retry", "transient"))
        self.assertEqual(item["consecutive_permanent_failures"], 0)

    def test_a_bug_in_the_siri_path_never_loses_a_sale(self):
        with mock.patch("services.siri_bills.replay_queued_bill", side_effect=ValueError("bug")):
            status, _item, _ = self.run_item(queued())                                       # normal sale: old path delivers
            self.assertEqual(status, "success")
            self.old.assert_called_once()
            status, item, _ = self.run_item(queued(unsure=True))                             # unsure sale: waits, retry
            self.assertEqual((status, item["last_error_class"]), ("retry", "transient"))
            self.assertEqual(self.old.call_count, 1)


class EnqueueTests(unittest.TestCase):
    def test_the_unsure_flag_and_the_request_id_are_kept_in_the_queued_sale(self):
        folder = tempfile.mkdtemp(prefix="siri-bills-queue-")
        queue_file = os.path.join(folder, "offline_bill_queue.json")
        with open(queue_file, "w", encoding="utf-8") as f:
            f.write("[]")
        with mock.patch.object(offline_bill_queue, "OFFLINE_BILL_QUEUE_FILE", queue_file), \
                mock.patch.object(offline_bill_queue, "_persist_local_offline_bill_snapshot"):
            a = offline_bill_queue.enqueue_bill_create("cashier-1", dict(SALE, _client_request_id="r5"), siri_unsure=True)
            b = offline_bill_queue.enqueue_bill_create("cashier-1", dict(SALE, _client_request_id="r5"), siri_unsure=True)
            c = offline_bill_queue.enqueue_bill_create("cashier-1", dict(SALE, _client_request_id="r6"))
        with open(queue_file, encoding="utf-8") as f:
            queue = json.load(f)
        self.assertEqual(a["bill_id"], b["bill_id"])                                         # the same sale twice = one queued item
        self.assertEqual(len(queue), 2)
        self.assertTrue(queue[0]["siri_unsure"] and queue[0]["client_request_id"] == "r5")
        self.assertNotIn("siri_unsure", queue[1])                                            # an ordinary offline sale has no flag
        self.assertNotEqual(a["bill_id"], c["bill_id"])


class ClassifyTests(unittest.TestCase):
    def test_siri_apis_verdict_is_believed_over_the_wording(self):
        retry, final = Exception("validation failed: duplicate key"), Exception("connection reset by peer")
        retry.siri_retryable, final.siri_retryable = True, False
        self.assertEqual(queue_common.classify_error(retry), "transient")
        self.assertEqual(queue_common.classify_error(final), "permanent")

    def test_without_a_verdict_it_classifies_exactly_as_before(self):
        self.assertEqual(queue_common.classify_error(Exception("connection reset by peer")), "transient")
        self.assertEqual(queue_common.classify_error(Exception("[Errno 11001] getaddrinfo failed")), "transient")
        self.assertEqual(queue_common.classify_error(Exception("duplicate key value violates unique constraint")), "permanent")


# ---------------------------------------------------------------- the save-a-bill entry point

class DispatchTests(Base):
    def setUp(self):
        super().setUp()
        self.login()
        from services import billing_service
        self.bs = billing_service
        self.patches2 = [
            mock.patch("services.billing_service.get_supabase_client", return_value=mock.Mock(is_offline_fallback=False)),
            mock.patch("services.billing_service.create_bill_transaction", return_value={"bill_id": "OLD-1"}),
            mock.patch("utils.offline_bill_queue.enqueue_bill_create", return_value={"bill_id": "INV-KNL-130620260004", "queue_id": "Q-9"}),
        ]
        self.supa, self.old, self.enqueue = [p.start() for p in self.patches2]

    def tearDown(self):
        for p in self.patches2:
            p.stop()
        super().tearDown()

    def test_siri_api_makes_the_bill_and_neither_the_queue_nor_the_old_path_is_touched(self):
        self.siri.routes[("POST", "/api/store/bills")] = CREATED
        out = self.bs.dispatch_bill_create("cashier-1", dict(SALE))
        self.assertEqual((out["queued"], out["bill_id"]), (False, "INV-KNL-130620260001"))
        self.enqueue.assert_not_called()
        self.old.assert_not_called()

    def test_it_still_works_when_the_direct_database_path_is_offline(self):
        self.supa.return_value = mock.Mock(is_offline_fallback=True)
        self.siri.routes[("POST", "/api/store/bills")] = CREATED
        out = self.bs.dispatch_bill_create("cashier-1", dict(SALE))
        self.assertEqual(out["bill_id"], "INV-KNL-130620260001")
        self.enqueue.assert_not_called()

    def test_an_unclear_attempt_is_queued_with_the_same_request_id_and_the_unsure_flag(self):
        self.siri.routes[("POST", "/api/store/bills")] = (503, {"retryable": True})
        self.siri.routes[("GET", "/api/store/bills/by-request/r1")] = (200, {"found": False})
        out = self.bs.dispatch_bill_create("cashier-1", dict(SALE, _client_request_id="r1"))
        self.assertTrue(out["queued"])
        self.assertEqual(out["bill_id"], "INV-KNL-130620260004")
        self.assertTrue(self.enqueue.call_args.kwargs["siri_unsure"])
        self.assertEqual(self.enqueue.call_args.kwargs["bill_payload"]["_client_request_id"], "r1")
        self.old.assert_not_called()                                                         # never the direct path after an unclear attempt

    def test_a_request_id_is_made_when_the_screen_sent_none_and_reaches_the_queue(self):
        self.api.switches()                                                                  # the switches are known first
        self.siri.routes[("POST", "/api/store/bills")] = (502, {})
        self.siri.fail = httpx.ReadTimeout("slow")
        self.bs.dispatch_bill_create("cashier-1", dict(SALE))
        self.assertTrue(self.enqueue.call_args.kwargs["bill_payload"]["_client_request_id"].startswith("pc-"))

    def test_a_final_no_goes_to_the_route_and_nothing_is_queued(self):
        self.siri.routes[("POST", "/api/store/bills")] = (400, {"message": "Insufficient stock", "code": "insufficient_stock", "retryable": False})
        with self.assertRaises(SiriBillRefused):
            self.bs.dispatch_bill_create("cashier-1", dict(SALE))
        self.enqueue.assert_not_called()
        self.old.assert_not_called()

    def test_with_the_switch_off_the_old_path_runs_exactly_as_before(self):
        self.siri.routes[("GET", "/api/store/config")] = switches_body(bills_write=False)
        self.now[0] += 125
        out = self.bs.dispatch_bill_create("cashier-1", dict(SALE))
        self.assertEqual(out["bill_id"], "OLD-1")
        self.assertEqual(self.calls("POST", "/api/store/bills"), [])
        self.old.assert_called_once()

    def test_a_refused_token_lets_the_old_path_make_the_sale(self):
        self.siri.routes[("POST", "/api/store/bills")] = (401, {"error": "expired"})
        out = self.bs.dispatch_bill_create("cashier-1", dict(SALE))
        self.assertEqual(out["bill_id"], "OLD-1")


class RouteTests(unittest.TestCase):
    def test_a_final_no_from_siri_api_reaches_the_screen_with_its_own_reason_and_status(self):
        import main
        from flask_jwt_extended import create_access_token
        refusal = SiriBillRefused(423, {"error": "billing_paused", "message": "An audit is in progress", "since": "2026-11-13"})
        with main.app.app_context():
            token = create_access_token(identity="cashier-1", additional_claims={"role": "billing_user"})
        users = mock.Mock()
        users.table.return_value.select.return_value.eq.return_value.execute.return_value.data = [{"id": "cashier-1"}]
        with mock.patch("auth.auth.get_supabase_client", return_value=users), \
                mock.patch("routes.billing_routes.current_pause", return_value=None), \
                mock.patch("routes.billing_routes._lookup_bill_by_request_id", return_value=None), \
                mock.patch("routes.billing_routes.dispatch_bill_create", side_effect=refusal):
            r = main.app.test_client().post("/api/bills", json=dict(SALE), headers={"Authorization": f"Bearer {token}"})
        self.assertEqual(r.status_code, 423)
        self.assertEqual(r.get_json(), {"error": "billing_paused", "message": "An audit is in progress", "since": "2026-11-13"})


if __name__ == "__main__":
    unittest.main()
