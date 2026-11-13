"""
Returns, damaged returns, return orders, transfers and discounts through siri-api, with the offline queues:
a write is never done twice and never lost, and a write siri-api MAY have done is never re-run the old way.

A fake siri-api answers (httpx.MockTransport); queue files are temp files; the old database path is a mock.
Run from the backend folder:   .venv\\Scripts\\python.exe -m unittest tests.test_siri_writes -v
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

from flask import Flask, jsonify  # noqa: E402
from flask_jwt_extended import JWTManager, create_access_token, jwt_required  # noqa: E402

from services import siri_bills, siri_writes  # noqa: E402
from services.siri_bills import SiriBillRefused, SiriBillUnsure, SiriReplayError  # noqa: E402
from utils import discount_approval_cache, siri_api  # noqa: E402
from utils.siri_api import SiriApi, SiriResponse  # noqa: E402
from utils.siri_proxy import via_siri_api  # noqa: E402

ALL_ON = switches_body(reads=True, returns=True, transfers=True, discounts=True, bills_write=True)
DAMAGE_ROW = {"id": "SDR-AAA111", "store_id": "s1", "product_id": "p1", "quantity": 2, "reason": "broken clasp",
              "reason_type": "damaged", "damage_origin": "store", "notes": "n"}
RETURN_HEADER = {"return_id": "RET-AAA111", "store_id": "s1", "message": "monthly"}
RETURN_LINES = [{"product_id": "p1", "quantity": 3, "reason_type": "low_sales", "reason": "slow", "notes": ""}]
VERIFY = {"verification_session_id": "S-1", "items": [{"transfer_item_id": "I1", "verified_qty": 2}]}


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="siri-writes-test-")
        self.siri = FakeSiri()
        self.now = [1000.0]
        os.environ.pop("SIRI_API_DISABLE", None)
        self.api = SiriApi(base_url="https://siri.test", data_dir=self.dir, transport=self.siri.transport(), clock=lambda: self.now[0])
        siri_api._client = self.api
        self.siri.routes[("POST", "/api/auth/login")] = LOGIN_OK
        self.siri.routes[("GET", "/api/store/config")] = ALL_ON
        discount_approval_cache._CACHE.clear()

    def tearDown(self):
        siri_api._client = None
        os.environ.pop("SIRI_API_DISABLE", None)
        discount_approval_cache._CACHE.clear()

    def login(self):
        self.assertTrue(self.api.login("a@x.com", "pw"))

    def calls(self, method, path):
        return [c for c in self.siri.calls if c.method == method and c.url.path == path]


# ---------------------------------------------------------------- "did the request even leave this PC?"

class NotSentTests(unittest.TestCase):
    def test_only_a_request_that_never_left_is_not_sent(self):
        for error in ("ConnectError: refused", "ConnectTimeout: x", "PoolTimeout: x", "no siri-api session", "no replay pass for this cashier"):
            self.assertTrue(SiriResponse(0, b"", {}, error).not_sent, error)
        for error in ("ReadTimeout: slow", "RemoteProtocolError: dropped", "ReadError: x", "WriteError: x"):
            self.assertFalse(SiriResponse(0, b"", {}, error).not_sent, error)         # it may have been processed
        self.assertFalse(SiriResponse(503, b"{}").not_sent)
        self.assertFalse(SiriResponse(200, b"{}").not_sent)


# ---------------------------------------------------------------- the proxy for writes

class WriteProxyTests(Base):
    def setUp(self):
        super().setUp()
        self.legacy_calls, self.after_calls = [], []
        app = Flask(__name__)
        app.config["JWT_SECRET_KEY"] = "test-secret-that-is-long-enough-for-hmac-sha256"
        JWTManager(app)

        def legacy_approve(rid):
            self.legacy_calls.append("legacy")
            return jsonify({"from": "old path"})

        def legacy_search():
            self.legacy_calls.append("legacy")
            return jsonify({"from": "old path"})

        def after(status, body):
            self.after_calls.append((status, body))
            if body.get("explode"):
                raise RuntimeError("hook bug")

        app.add_url_rule("/api/approve/<rid>", "approve", jwt_required()(via_siri_api(
            "returns", "/api/store/returns/{rid}/approve", methods=("POST",), repeatable=False, after=after)(legacy_approve)),
            methods=["GET", "POST"])
        app.add_url_rule("/api/search", "search", jwt_required()(via_siri_api(
            "returns", "/api/store/returns/search", methods=("POST",))(legacy_search)), methods=["GET", "POST"])
        self.client = app.test_client()
        with app.app_context():
            self.h = {"Authorization": "Bearer " + create_access_token(identity="cashier-1")}
        self.login()

    def post(self, path, body=None):
        return self.client.post(path, json=body or {"x": 1}, headers=self.h)

    def test_a_write_with_the_switch_off_runs_the_old_path_and_never_calls_siri_api(self):
        self.siri.routes[("GET", "/api/store/config")] = switches_body(returns=False)
        self.now[0] += 125
        self.assertEqual(self.post("/api/approve/R1").get_json(), {"from": "old path"})
        self.assertEqual(self.calls("POST", "/api/store/returns/R1/approve"), [])

    def test_a_write_goes_to_siri_api_with_its_body_and_the_old_code_does_not_run(self):
        self.siri.routes[("POST", "/api/store/returns/R1/approve")] = (200, {"status": "approved"})
        r = self.post("/api/approve/R1", {"reason": "ok"})
        self.assertEqual((r.status_code, r.get_json()), (200, {"status": "approved"}))
        self.assertEqual(json.loads(self.calls("POST", "/api/store/returns/R1/approve")[0].content), {"reason": "ok"})
        self.assertEqual(self.legacy_calls, [])
        self.assertEqual(self.after_calls, [(200, {"status": "approved"})])

    def test_a_final_no_is_returned_and_the_after_hook_does_not_run(self):
        self.siri.routes[("POST", "/api/store/returns/R1/approve")] = (409, {"code": "not_pending", "message": "already approved"})
        r = self.post("/api/approve/R1")
        self.assertEqual((r.status_code, r.get_json()["code"]), (409, "not_pending"))
        self.assertEqual((self.legacy_calls, self.after_calls), ([], []))

    def test_a_write_siri_api_may_have_done_is_never_repeated_the_old_way(self):
        """The old 'approve' would restock a second time: the cashier gets a retryable 503 instead."""
        for answer in ((503, {"retryable": True}), (500, {}), (502, {})):
            self.siri.routes[("POST", "/api/store/returns/R1/approve")] = answer
            r = self.post("/api/approve/R1")
            self.assertEqual((r.status_code, r.get_json()["code"], r.get_json()["retryable"]), (503, "siri_unclear", True), answer)
        for failure in (httpx.ReadTimeout("slow"), httpx.RemoteProtocolError("dropped")):
            self.siri.fail = failure
            r = self.post("/api/approve/R1")
            self.assertEqual((r.status_code, r.get_json()["code"]), (503, "siri_unclear"), failure)
        self.assertEqual(self.legacy_calls, [])

    def test_a_write_that_never_left_this_pc_or_whose_token_was_refused_may_use_the_old_path(self):
        self.api.switches()                                          # the switches are known first, so the write IS attempted
        approve = ("POST", "/api/store/returns/R1/approve")
        self.siri.fail = httpx.ConnectError("no internet")
        self.assertEqual(self.post("/api/approve/R1").get_json(), {"from": "old path"})
        self.assertEqual(len(self.calls(*approve)), 1)               # it was tried, never got through, so the old path ran
        self.siri.fail = None
        self.siri.routes[approve] = (401, {"error": "expired"})
        self.assertEqual(self.post("/api/approve/R1").get_json(), {"from": "old path"})
        self.assertEqual(len(self.calls(*approve)), 2)               # tried again, refused, so the old path ran
        self.assertEqual(len(self.legacy_calls), 2)

    def test_a_search_that_only_reads_falls_back_to_the_old_path_on_trouble(self):
        self.siri.routes[("POST", "/api/store/returns/search")] = (503, {})
        self.assertEqual(self.post("/api/search").get_json(), {"from": "old path"})
        self.siri.fail = httpx.ReadTimeout("slow")
        self.assertEqual(self.post("/api/search").get_json(), {"from": "old path"})

    def test_only_the_listed_methods_are_forwarded(self):
        self.siri.routes[("POST", "/api/store/returns/R1/approve")] = (200, {"status": "approved"})
        r = self.client.get("/api/approve/R1", headers=self.h)
        self.assertEqual(r.get_json(), {"from": "old path"})
        self.assertEqual(self.calls("GET", "/api/store/returns/R1/approve"), [])

    def test_a_failing_after_hook_never_changes_the_answer(self):
        self.siri.routes[("POST", "/api/store/returns/R1/approve")] = (200, {"explode": True})
        r = self.post("/api/approve/R1")
        self.assertEqual((r.status_code, r.get_json()), (200, {"explode": True}))


# ---------------------------------------------------------------- the helper for queue-backed writes

class RequestBuilderTests(unittest.TestCase):
    def test_a_damaged_return_uses_its_row_id_as_the_request_id(self):
        body = siri_writes.damage_return_request(DAMAGE_ROW)
        self.assertEqual(body["_client_request_id"], "SDR-AAA111")
        self.assertEqual(body["selectedItems"], [{"productId": "p1", "quantity": 2, "note": "n"}])
        self.assertEqual((body["reason"], body["reasonType"], body["damageOrigin"]), ("broken clasp", "damaged", "store"))

    def test_a_return_order_uses_its_return_id_as_the_request_id(self):
        body = siri_writes.return_order_request(RETURN_HEADER, RETURN_LINES)
        self.assertEqual(body["_client_request_id"], "RET-AAA111")
        self.assertEqual(body["items"][0], {"productId": "p1", "quantity": 3, "reasonType": "low_sales", "reason": "slow", "note": ""})
        self.assertEqual(body["note"], "monthly")


class AttemptPostTests(Base):
    PATH = "/api/store/store-damage-returns"

    def attempt(self, user="cashier-1"):
        return siri_writes.attempt_post("returns", user, self.PATH, siri_writes.damage_return_request(DAMAGE_ROW))

    def test_not_used_without_a_session_with_the_switch_off_or_for_another_cashier(self):
        self.assertIsNone(self.attempt())
        self.login()
        self.assertIsNone(self.attempt(user="cashier-2"))
        self.siri.routes[("GET", "/api/store/config")] = switches_body(returns=False)
        self.now[0] += 125
        self.assertIsNone(self.attempt())
        self.assertEqual(self.calls("POST", self.PATH), [])

    def test_an_answer_is_returned_and_the_cashiers_token_is_used(self):
        self.login()
        self.siri.routes[("POST", self.PATH)] = (201, {"count": 1, "rows": [{"id": "SDR-AAA111"}]})
        self.assertEqual(self.attempt()["rows"][0]["id"], "SDR-AAA111")
        self.assertEqual(self.calls("POST", self.PATH)[0].headers["authorization"], "Bearer tok-1")

    def test_a_final_no_is_raised_for_the_route_to_show(self):
        self.login()
        self.siri.routes[("POST", self.PATH)] = (400, {"message": "reason is required", "code": "invalid_return"})
        with self.assertRaises(SiriBillRefused) as ctx:
            self.attempt()
        self.assertEqual(ctx.exception.status, 400)

    def test_a_refused_token_means_the_old_path(self):
        self.login()
        self.siri.routes[("POST", self.PATH)] = (401, {"error": "expired"})
        self.assertIsNone(self.attempt())

    def test_a_connection_that_never_opened_means_the_old_path(self):
        self.login()
        self.api.switches()                                                                  # the switches are known first
        self.siri.fail = httpx.ConnectError("no internet")
        self.assertIsNone(self.attempt())

    def test_a_lost_answer_is_unsure(self):
        self.login()
        self.api.switches()
        for failure in (httpx.ReadTimeout("slow"), httpx.RemoteProtocolError("dropped")):
            self.siri.fail = failure
            with self.assertRaises(SiriBillUnsure):
                self.attempt()
        self.siri.fail = None
        self.siri.routes[("POST", self.PATH)] = (503, {"retryable": True})
        with self.assertRaises(SiriBillUnsure):
            self.attempt()


def queued_damage(user="cashier-1", unsure=False):
    item = {"queue_id": "QDR-1", "type": "create_store_damage_return", "user_id": user, "payload": dict(DAMAGE_ROW), "attempts": 0}
    if unsure:
        item["siri_unsure"] = True
    return item


def queued_order(user="cashier-1", unsure=False):
    item = {"queue_id": "QRO-1", "type": "create_return_order", "user_id": user,
            "payload": {"header": dict(RETURN_HEADER), "lines": [dict(ln) for ln in RETURN_LINES]}, "attempts": 0}
    if unsure:
        item["siri_unsure"] = True
    return item


def queued_transfer(user="cashier-1", unsure=False):
    item = {"queue_id": "QTV-1", "type": "create_transfer_verification", "user_id": user, "store_id": "s1", "order_id": "O1",
            "verification_data": dict(VERIFY), "attempts": 0}
    if unsure:
        item["siri_unsure"] = True
    return item


KINDS = (("damage_return", queued_damage, "/api/store/replay/damage-returns"),
         ("return_order", queued_order, "/api/store/replay/return-orders"),
         ("transfer", queued_transfer, "/api/store/replay/transfer-orders/O1/verify"))


class DeliverQueuedTests(Base):
    def test_each_kind_is_sent_to_its_replay_route_with_the_cashiers_pass_and_its_own_key(self):
        self.login()
        for kind, make, path in KINDS:
            self.siri.routes[("POST", path)] = (201, {"ok": True})
            self.assertTrue(siri_writes.deliver_queued(kind, make()), kind)
            self.assertEqual(self.calls("POST", path)[-1].headers["authorization"], "Bearer replay-s1", kind)
        body = json.loads(self.calls("POST", "/api/store/replay/damage-returns")[0].content)
        self.assertEqual(body["_client_request_id"], "SDR-AAA111")
        body = json.loads(self.calls("POST", "/api/store/replay/return-orders")[0].content)
        self.assertEqual(body["_client_request_id"], "RET-AAA111")
        body = json.loads(self.calls("POST", "/api/store/replay/transfer-orders/O1/verify")[0].content)
        self.assertEqual(body["verification_session_id"], "S-1")

    def test_with_the_switch_off_or_no_pass_the_old_path_is_to_deliver_an_ordinary_item(self):
        self.login()
        for kind, make, path in KINDS:
            self.assertFalse(siri_writes.deliver_queued(kind, make(user="someone-else")), kind)       # no pass for them
        self.siri.routes[("GET", "/api/store/config")] = switches_body(returns=False, transfers=False)
        self.now[0] += 125
        for kind, make, path in KINDS:
            self.assertFalse(siri_writes.deliver_queued(kind, make()), kind)
        self.assertEqual([c for c in self.siri.calls if "/replay/" in c.url.path], [])

    def test_siri_api_trouble_lets_an_ordinary_item_use_the_old_path_but_makes_an_unsure_one_wait(self):
        self.login()
        for kind, make, path in KINDS:
            self.siri.routes[("POST", path)] = (503, {"retryable": True})
            self.assertFalse(siri_writes.deliver_queued(kind, make()), kind)
            with self.assertRaises(SiriReplayError) as ctx:
                siri_writes.deliver_queued(kind, make(unsure=True))
            self.assertIs(ctx.exception.siri_retryable, True, kind)
            with self.assertRaises(SiriReplayError):                                               # no pass, still waits
                siri_writes.deliver_queued(kind, make(user="someone-else", unsure=True))

    def test_a_final_answer_is_raised_as_final_and_the_old_path_is_not_tried(self):
        self.login()
        for kind, make, path in KINDS:
            self.siri.routes[("POST", path)] = (409, {"code": "order_closed", "message": "closed", "retryable": False})
            for item in (make(), make(unsure=True)):
                with self.assertRaises(SiriReplayError) as ctx:
                    siri_writes.deliver_queued(kind, item)
                self.assertIs(ctx.exception.siri_retryable, False, kind)

    def test_a_bug_in_the_siri_path_never_loses_an_item(self):
        self.login()
        with mock.patch("services.siri_writes._replay", side_effect=ValueError("bug")):
            self.assertFalse(siri_writes.deliver_queued("damage_return", queued_damage()))          # old path delivers
            with self.assertRaises(SiriReplayError):
                siri_writes.deliver_queued("damage_return", queued_damage(unsure=True))             # waits


# ---------------------------------------------------------------- the three queue workers

class QueueWorkerBase(Base):
    module = None
    const = None
    run_name = None

    def setUp(self):
        super().setUp()
        self.login()
        self.qdir = tempfile.mkdtemp(prefix="siri-writes-queue-")
        self.qfile = os.path.join(self.qdir, "queue.json")
        self.supa = mock.Mock(is_offline_fallback=False)
        self.patchers = [
            mock.patch.object(self.module, self.const, self.qfile),
            mock.patch.object(self.module, "get_supabase_client", return_value=self.supa),
            mock.patch("utils.queue_common.log_offline_event"),
        ]
        for p in self.patchers:
            p.start()

    def tearDown(self):
        for p in self.patchers:
            p.stop()
        super().tearDown()

    def put(self, *items):
        with open(self.qfile, "w", encoding="utf-8") as f:
            json.dump(list(items), f)

    def queue(self):
        with open(self.qfile, encoding="utf-8") as f:
            return json.load(f)

    def run_queue(self):
        return getattr(self.module, self.run_name)()


class DamageQueueTests(QueueWorkerBase):
    run_name = "process_offline_damage_return_queue"

    @classmethod
    def setUpClass(cls):
        from utils import offline_damage_return_queue as m
        cls.module, cls.const = m, "OFFLINE_DAMAGE_RETURN_QUEUE_FILE"

    def test_siri_api_delivers_it_and_the_old_path_is_not_used(self):
        self.siri.routes[("POST", "/api/store/replay/damage-returns")] = (201, {"count": 1})
        self.put(queued_damage())
        out = self.run_queue()
        self.assertEqual((out["succeeded"], out["remaining"]), (1, 0))
        self.supa.table.assert_not_called()

    def test_an_unsure_row_waits_when_siri_api_is_down_and_is_never_saved_the_old_way(self):
        self.siri.routes[("POST", "/api/store/replay/damage-returns")] = (503, {"retryable": True})
        self.put(queued_damage(unsure=True))
        out = self.run_queue()
        self.assertEqual((out["succeeded"], out["remaining"]), (0, 1))
        self.assertEqual(self.queue()[0]["last_error_class"], "transient")
        self.supa.table.assert_not_called()

    def test_a_final_answer_counts_toward_giving_up_not_retry_for_ever(self):
        self.siri.routes[("POST", "/api/store/replay/damage-returns")] = (400, {"code": "invalid_return", "message": "bad", "retryable": False})
        self.put(queued_damage())
        self.run_queue()
        item = self.queue()[0]
        self.assertEqual((item["last_error_class"], item["consecutive_permanent_failures"]), ("permanent", 1))
        self.supa.table.assert_not_called()

    def test_with_the_direct_path_offline_and_siri_api_off_nothing_runs(self):
        self.supa.is_offline_fallback = True
        self.siri.routes[("GET", "/api/store/config")] = switches_body(returns=False)
        self.now[0] += 125
        self.put(queued_damage())
        self.assertEqual(self.run_queue()["processed"], 0)
        self.assertEqual(len(self.queue()), 1)

    def test_with_the_direct_path_offline_siri_api_on_still_delivers_and_never_touches_the_stand_in(self):
        self.supa.is_offline_fallback = True
        self.siri.routes[("POST", "/api/store/replay/damage-returns")] = (201, {"count": 1})
        self.put(queued_damage(), queued_damage(user="someone-else"))      # the second has no replay pass
        out = self.run_queue()
        self.assertEqual((out["succeeded"], out["remaining"]), (1, 1))
        self.assertEqual(self.queue()[0]["user_id"], "someone-else")
        self.assertEqual(self.queue()[0]["last_error_class"], "transient")  # waits; the offline stand-in is never used
        self.supa.table.assert_not_called()


class ReturnOrderQueueTests(QueueWorkerBase):
    run_name = "process_offline_return_order_queue"

    @classmethod
    def setUpClass(cls):
        from utils import offline_return_order_queue as m
        cls.module, cls.const = m, "OFFLINE_RETURN_ORDER_QUEUE_FILE"

    def test_siri_api_delivers_it_and_the_old_path_is_not_used(self):
        self.siri.routes[("POST", "/api/store/replay/return-orders")] = (201, {"count": 1})
        self.put(queued_order())
        out = self.run_queue()
        self.assertEqual((out["succeeded"], out["remaining"]), (1, 0))
        self.supa.table.assert_not_called()

    def test_an_unsure_order_waits_and_an_offline_stand_in_is_never_used(self):
        self.supa.is_offline_fallback = True
        self.siri.routes[("POST", "/api/store/replay/return-orders")] = (502, {})
        self.put(queued_order(unsure=True), queued_order(user="someone-else"))
        out = self.run_queue()
        self.assertEqual((out["succeeded"], out["remaining"]), (0, 2))
        self.supa.table.assert_not_called()


class TransferQueueTests(QueueWorkerBase):
    run_name = "process_offline_transfer_verification_queue"

    @classmethod
    def setUpClass(cls):
        from utils import offline_transfer_verification_queue as m
        cls.module, cls.const = m, "OFFLINE_TRANSFER_VERIFICATION_QUEUE_FILE"

    def setUp(self):
        super().setUp()
        self.legacy = mock.patch("routes.store_routes._apply_transfer_order_verification", return_value=({"message": "ok"}, 200))
        self.old = self.legacy.start()

    def tearDown(self):
        self.legacy.stop()
        super().tearDown()

    def test_siri_api_delivers_it_and_a_duplicate_answer_is_a_success(self):
        self.siri.routes[("POST", "/api/store/replay/transfer-orders/O1/verify")] = (200, {"status": "duplicate_ignored"})
        self.put(queued_transfer())
        out = self.run_queue()
        self.assertEqual((out["succeeded"], out["remaining"]), (1, 0))
        self.old.assert_not_called()

    def test_an_ordinary_item_falls_back_to_the_old_path_when_siri_api_is_down(self):
        self.siri.routes[("POST", "/api/store/replay/transfer-orders/O1/verify")] = (503, {"retryable": True})
        self.put(queued_transfer())
        out = self.run_queue()
        self.assertEqual(out["succeeded"], 1)
        self.old.assert_called_once()

    def test_an_unsure_item_waits_for_siri_api(self):
        self.siri.routes[("POST", "/api/store/replay/transfer-orders/O1/verify")] = (503, {"retryable": True})
        self.put(queued_transfer(unsure=True))
        out = self.run_queue()
        self.assertEqual((out["succeeded"], out["remaining"]), (0, 1))
        self.old.assert_not_called()


# ---------------------------------------------------------------- the entry points

class EntryPointTests(Base):
    def setUp(self):
        super().setUp()
        self.login()

    def test_damaged_return_goes_to_siri_api_queues_when_unsure_and_shows_a_refusal(self):
        from routes import return_routes as rr
        supa = mock.Mock(is_offline_fallback=False)
        with mock.patch.object(rr, "enqueue_damage_return_create", return_value={"queue_id": "QDR-9"}) as enqueue, \
                mock.patch.object(rr, "read_json_file", return_value=[]), mock.patch.object(rr, "write_json_file"), \
                mock.patch.object(rr, "_apply_local_stock_reduction"), mock.patch.object(rr, "invalidate_products_cache_for_store"):
            self.siri.routes[("POST", "/api/store/store-damage-returns")] = (201, {"rows": [{"id": "SDR-AAA111", "from": "siri"}]})
            out = rr._dispatch_damage_return_item(supa, "cashier-1", "s1", dict(DAMAGE_ROW), "damaged", "r", "now")
            self.assertEqual(out["from"], "siri")
            enqueue.assert_not_called()
            supa.table.assert_not_called()

            self.siri.routes[("POST", "/api/store/store-damage-returns")] = (503, {"retryable": True})
            out = rr._dispatch_damage_return_item(supa, "cashier-1", "s1", dict(DAMAGE_ROW), "damaged", "r", "now")
            self.assertTrue(out["queued"])
            self.assertTrue(enqueue.call_args.kwargs["siri_unsure"])
            supa.table.assert_not_called()                                                          # never the direct write

            self.siri.routes[("POST", "/api/store/store-damage-returns")] = (400, {"message": "reason is required"})
            with self.assertRaises(SiriBillRefused):
                rr._dispatch_damage_return_item(supa, "cashier-1", "s1", dict(DAMAGE_ROW), "damaged", "r", "now")

    def test_return_order_goes_to_siri_api_and_queues_with_the_unsure_flag_when_the_answer_is_lost(self):
        from routes import return_order_routes as ro
        supa = mock.Mock(is_offline_fallback=False)
        with mock.patch.object(ro, "enqueue_return_order_create", return_value={"queue_id": "QRO-9"}) as enqueue, \
                mock.patch.object(ro, "read_json_file", return_value=[]), mock.patch.object(ro, "write_json_file"):
            self.siri.routes[("POST", "/api/store/return-orders")] = (201, {"return": {"return_id": "RET-SERVER"}, "items": [1]})
            out = ro._dispatch_return_order(supa, "cashier-1", "s1", dict(RETURN_HEADER), [dict(ln) for ln in RETURN_LINES])
            self.assertEqual((out["queued"], out["return"]["return_id"]), (False, "RET-SERVER"))
            self.siri.fail = httpx.ReadTimeout("slow")
            out = ro._dispatch_return_order(supa, "cashier-1", "s1", dict(RETURN_HEADER), [dict(ln) for ln in RETURN_LINES])
            self.assertTrue(out["queued"] and enqueue.call_args.kwargs["siri_unsure"])
            supa.table.assert_not_called()

    def test_transfer_verification_goes_to_siri_api_applies_local_stock_and_handles_refusal_and_loss(self):
        from routes import store_routes as sr
        supa = mock.Mock(is_offline_fallback=False)
        path = "/api/store/transfer-orders/O1/verify"
        with mock.patch.object(sr, "enqueue_transfer_verification_create", return_value={"queue_id": "QTV-9", "verification_session_id": "S-1"}) as enqueue, \
                mock.patch.object(sr, "_update_local_storeinventory") as local, \
                mock.patch.object(sr, "invalidate_products_cache_for_store"), \
                mock.patch.object(sr, "_apply_transfer_order_verification", return_value=({"message": "old path"}, 200)) as old:
            self.siri.routes[("POST", path)] = (200, {"message": "applied", "local_inventory_deltas": {"p1": 2}})
            body, status = sr._dispatch_transfer_verification(supa, "cashier-1", "s1", "O1", dict(VERIFY))
            self.assertEqual((status, body["message"]), (200, "applied"))
            self.assertEqual(local.call_args[0][:3], ("s1", "p1", 2))                               # the PC's own stock copy follows
            old.assert_not_called()

            self.siri.routes[("POST", path)] = (409, {"code": "order_closed", "message": "Transfer order already closed"})
            body, status = sr._dispatch_transfer_verification(supa, "cashier-1", "s1", "O1", dict(VERIFY))
            self.assertEqual((status, body["code"]), (409, "order_closed"))

            self.siri.routes[("POST", path)] = (503, {"retryable": True})
            body, status = sr._dispatch_transfer_verification(supa, "cashier-1", "s1", "O1", dict(VERIFY))
            self.assertEqual((status, body["queued"]), (202, True))
            self.assertTrue(enqueue.call_args.kwargs["siri_unsure"])
            old.assert_not_called()

            body, status = sr._dispatch_transfer_verification(supa, "cashier-1", "s1", "O1", {"items": []})   # no session id
            self.assertEqual(body["message"], "old path")                                          # the old path reports its own 400
            old.assert_called_once()


# ---------------------------------------------------------------- the discount approval

class DiscountApprovalTests(Base):
    SALE = {"store_id": "s1", "items": [{"product_id": "p1", "quantity": 1, "unit_price": 100.0}], "total_amount": 80.0,
            "discount_percentage": 20}
    CREATED = (201, {"message": "Bill created successfully", "bill_id": "INV-KNL-130620260001", "bill": {"id": "x"}, "items_created": 1})

    def setUp(self):
        super().setUp()
        self.login()
        self.patches = [mock.patch("services.siri_bills._min_serial_hint", return_value=0),
                        mock.patch("utils.bill_item_snapshot.replace_bill_item_snapshots"),
                        mock.patch("utils.stock_stream.publish"), mock.patch("utils.products_cache.invalidate_products_cache_for_store")]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        super().tearDown()

    def sent(self):
        return json.loads(self.calls("POST", "/api/store/bills")[-1].content)

    def test_the_managers_approval_is_remembered_with_its_signed_token_after_the_code_is_accepted(self):
        app = Flask(__name__)
        app.config["JWT_SECRET_KEY"] = "test-secret-that-is-long-enough-for-hmac-sha256"
        JWTManager(app)
        with app.app_context():
            token = create_access_token(identity="cashier-1")
        with app.test_request_context("/", headers={"Authorization": f"Bearer {token}"}):
            from flask_jwt_extended import verify_jwt_in_request
            verify_jwt_in_request()
            discount_approval_cache.remember_deferred_approval(200, {"deferred": True, "approved_by": "manager-1", "approval_token": "SIGNED"})
            discount_approval_cache.remember_deferred_approval(200, {"deferred": False, "approval_token": "x"})      # not a deferred approval
        entry = discount_approval_cache.pop_discount_approval("cashier-1")
        self.assertEqual((entry["approved_by"], entry["token"]), ("manager-1", "SIGNED"))
        self.assertIsNone(discount_approval_cache.pop_discount_approval("cashier-1"))

    def test_a_bill_with_a_big_discount_carries_the_remembered_approval_to_siri_api_and_uses_it_up(self):
        self.siri.routes[("POST", "/api/store/bills")] = self.CREATED
        discount_approval_cache.set_discount_approval("cashier-1", "manager-1", "SIGNED")
        out = siri_bills.attempt_online_bill("cashier-1", dict(self.SALE))
        self.assertFalse(out["queued"])
        sent = self.sent()
        self.assertTrue(sent["_deferred_discount_approval"])
        self.assertEqual(sent["_discount_approval_token"], "SIGNED")
        self.assertIsNone(discount_approval_cache.pop_discount_approval("cashier-1"))        # used up

    def test_the_approval_is_given_back_when_siri_api_refuses_or_never_sees_the_sale(self):
        discount_approval_cache.set_discount_approval("cashier-1", "manager-1", "SIGNED")
        self.siri.routes[("POST", "/api/store/bills")] = (400, {"message": "no stock", "code": "insufficient_stock", "retryable": False})
        data = dict(self.SALE)
        with self.assertRaises(SiriBillRefused):
            siri_bills.attempt_online_bill("cashier-1", data)
        self.assertNotIn("_deferred_discount_approval", data)
        entry = discount_approval_cache.pop_discount_approval("cashier-1")                    # still there for the retry
        self.assertEqual(entry["token"], "SIGNED")
        discount_approval_cache.set_discount_approval("cashier-1", "manager-1", "SIGNED")
        self.siri.routes[("POST", "/api/store/bills")] = (401, {"error": "expired"})
        self.assertIsNone(siri_bills.attempt_online_bill("cashier-1", dict(self.SALE)))
        self.assertIsNotNone(discount_approval_cache.pop_discount_approval("cashier-1"))     # the old path can use it

    def test_an_unsure_sale_keeps_the_approval_inside_the_queued_copy(self):
        self.siri.routes[("POST", "/api/store/bills")] = (503, {"retryable": True})
        self.siri.routes[("GET", "/api/store/bills/by-request/r1")] = (200, {"found": False})
        discount_approval_cache.set_discount_approval("cashier-1", "manager-1", "SIGNED")
        data = dict(self.SALE, _client_request_id="r1")
        with self.assertRaises(SiriBillUnsure):
            siri_bills.attempt_online_bill("cashier-1", data)
        self.assertTrue(data["_deferred_discount_approval"])                                  # travels with the queued sale
        self.assertEqual(data["_discount_approval_token"], "SIGNED")
        self.assertIsNone(discount_approval_cache.pop_discount_approval("cashier-1"))

    def test_no_approval_is_taken_for_a_small_discount_or_when_a_request_was_already_approved(self):
        self.siri.routes[("POST", "/api/store/bills")] = self.CREATED
        discount_approval_cache.set_discount_approval("cashier-1", "manager-1", "SIGNED")
        siri_bills.attempt_online_bill("cashier-1", dict(self.SALE, discount_percentage=10))
        siri_bills.attempt_online_bill("cashier-1", dict(self.SALE, discount_request_id="D1"))
        self.assertNotIn("_deferred_discount_approval", self.sent())
        self.assertIsNotNone(discount_approval_cache.pop_discount_approval("cashier-1"))     # untouched


if __name__ == "__main__":
    unittest.main()
