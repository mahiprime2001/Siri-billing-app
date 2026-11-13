"""
Bill history reads and bill edit / revise / cancel through siri-api (the real /bills routes, a fake siri-api).

  * switches off or no siri session -> the old code runs, no network call;
  * bills_read on -> history, detail, stats, replacements, events come from siri-api;
  * items and the edit screen carry this PC's own saved tax/HSN detail laid over siri-api's answer;
  * bills_write on -> revise / cancel / update / delete go to siri-api, and a lost answer is NEVER repeated down the
    old path (it could restock twice), a refused connection is;
  * after a revise the receipt detail on this PC is replaced; after a cancel the product cache is refreshed.

Run from the backend folder:
    .venv\\Scripts\\python.exe -m unittest tests.test_siri_bill_views -v
"""
import copy
import os
import sys
import unittest
from unittest import mock

import httpx

BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND not in sys.path:
    sys.path.insert(0, BACKEND)

from flask import Flask  # noqa: E402
from flask_jwt_extended import JWTManager, create_access_token  # noqa: E402

import routes.billing_routes as billing  # noqa: E402
from services import siri_bill_views as views  # noqa: E402
from tests.test_siri_api import ClientBase, switches_body  # noqa: E402
from utils import siri_api  # noqa: E402


class BillViewsBase(ClientBase):
    def setUp(self):
        super().setUp()
        siri_api._client = self.api
        app = Flask(__name__)
        app.config["JWT_SECRET_KEY"] = "test-secret-that-is-long-enough-for-hmac-sha256"
        JWTManager(app)
        app.register_blueprint(billing.billing_bp)
        self.client = app.test_client()
        with app.app_context():
            self.headers = {"Authorization": "Bearer " + create_access_token(identity="cashier-1")}

        self.old_db = mock.MagicMock(name="old_db")
        self.old_db.table.return_value.select.return_value.eq.return_value.execute.return_value.data = [{"id": "cashier-1"}]
        user_ok = mock.MagicMock()
        user_ok.table.return_value.select.return_value.eq.return_value.execute.return_value.data = [{"id": "cashier-1"}]
        self.snapshots = []
        self.patchers = [
            mock.patch("auth.auth.get_supabase_client", return_value=user_ok),
            mock.patch.object(billing, "get_supabase_client", return_value=self.old_db),
            mock.patch("utils.bill_item_snapshot.get_bill_item_snapshots", side_effect=lambda bid: list(self.snapshots)),
            mock.patch("utils.bill_item_snapshot.replace_bill_item_snapshots"),
            mock.patch("utils.products_cache.invalidate_all_products_cache"),
            mock.patch("utils.stock_stream.publish"),
        ]
        mocks = [p.start() for p in self.patchers]
        self.replace_snapshots, self.invalidate, self.publish = mocks[3], mocks[4], mocks[5]
        self.addCleanup(mock.patch.stopall)
        self.old_calls_before = self.old_db.table.call_count

    def tearDown(self):
        siri_api._client = None
        super().tearDown()

    def turn_on(self, **groups):
        self.siri.routes[("GET", "/api/store/config")] = switches_body(**groups)
        self.login()
        self.api.switches()          # fetched now: with the network broken later, unknown switches would mean "off"

    def old_path_ran(self):
        return self.old_db.table.call_count > self.old_calls_before

    def siri_calls(self, path_prefix="/api/store/bills"):
        return [c for c in self.siri.calls if c.url.path.startswith(path_prefix)]


class ReadTests(BillViewsBase):
    def test_switch_off_means_old_code_and_no_siri_call(self):
        self.turn_on(bills_read=False)
        self.client.get("/bills/INV-1/events", headers=self.headers)
        self.assertTrue(self.old_path_ran())
        self.assertEqual(self.siri_calls(), [])

    def test_no_siri_session_means_old_code(self):
        self.client.get("/bills/INV-1/events", headers=self.headers)
        self.assertTrue(self.old_path_ran())
        self.assertEqual(self.siri.calls, [])

    def test_history_detail_stats_replacements_events_come_from_siri_api(self):
        self.turn_on(bills_read=True)
        answers = {
            "/api/store/bills": [{"id": "INV-1"}],
            "/api/store/bills/stats": {"total_bills": 3},
            "/api/store/bills/INV-1": {"id": "INV-1", "can_edit": True},
            "/api/store/bills/INV-1/replacements": [{"id": "r1"}],
            "/api/store/bills/INV-1/events": [{"id": "e1"}],
        }
        for path, body in answers.items():
            self.siri.routes[("GET", path)] = (200, body)
        for local, siri_path in (("/bills?store_id=s1&limit=5", "/api/store/bills"), ("/bills/stats", "/api/store/bills/stats"),
                                 ("/bills/INV-1", "/api/store/bills/INV-1"),
                                 ("/bills/INV-1/replacements", "/api/store/bills/INV-1/replacements"),
                                 ("/bills/INV-1/events", "/api/store/bills/INV-1/events")):
            r = self.client.get(local, headers=self.headers)
            self.assertEqual((r.status_code, r.get_json()), (200, answers[siri_path]), local)
            self.assertEqual(r.headers["X-Siri-Api"], "1")
        self.assertFalse(self.old_path_ran())
        sent = [c for c in self.siri_calls() if c.url.path == "/api/store/bills"][0]
        self.assertEqual(dict(sent.url.params), {"store_id": "s1", "limit": "5"})

    def test_a_real_no_is_returned_not_overridden(self):
        self.turn_on(bills_read=True)
        self.siri.routes[("GET", "/api/store/bills/INV-9")] = (404, {"message": "Bill not found"})
        r = self.client.get("/bills/INV-9", headers=self.headers)
        self.assertEqual((r.status_code, r.get_json()), (404, {"message": "Bill not found"}))
        self.assertFalse(self.old_path_ran())

    def test_siri_api_trouble_falls_back_to_the_old_code(self):
        self.turn_on(bills_read=True)
        self.siri.fail = httpx.ReadTimeout("slow")
        self.client.get("/bills/INV-1/events", headers=self.headers)
        self.assertTrue(self.old_path_ran())


class OverlayTests(BillViewsBase):
    ITEMS = [
        {"id": 1, "billid": "INV-1", "productid": "p1", "quantity": 2, "price": 100.0, "total": 200.0,
         "products": {"name": "Ring", "barcode": "B1", "tax": 3.0, "hsn_code": "7113"}, "tax_percentage": 3.0, "hsn_code": "7113"},
        {"id": 2, "billid": "INV-1", "productid": "p2", "quantity": 1, "price": 50.0, "total": 50.0, "products": {}},
    ]

    def test_items_get_this_pcs_saved_tax_and_hsn(self):
        self.turn_on(bills_read=True)
        self.siri.routes[("GET", "/api/store/bills/INV-1/items")] = (200, copy.deepcopy(self.ITEMS))
        self.snapshots = [
            {"productid": "p1", "quantity": 2, "price": 100.0, "total": 200.0, "tax_percentage": 5.0, "hsn_code": "9999", "name": "Old", "barcode": "X"},
            {"productid": "p2", "quantity": 1, "price": 50.0, "total": 50.0, "tax_percentage": 12.0, "hsn_code": "6203", "name": "Shirt", "barcode": "B2"},
        ]
        out = self.client.get("/bills/INV-1/items", headers=self.headers).get_json()
        self.assertEqual((out[0]["tax_percentage"], out[0]["taxPercentage"], out[0]["hsn_code"], out[0]["hsnCode"]), (5.0, 5.0, "9999", "9999"))
        self.assertEqual(out[0]["products"]["tax"], 5.0)
        self.assertEqual(out[0]["products"]["name"], "Ring")            # siri-api's own name is kept
        self.assertEqual((out[1]["products"]["name"], out[1]["products"]["barcode"], out[1]["hsn_code"]), ("Shirt", "B2", "6203"))

    def test_items_without_a_saved_snapshot_are_left_as_siri_api_gave_them(self):
        self.turn_on(bills_read=True)
        self.siri.routes[("GET", "/api/store/bills/INV-1/items")] = (200, [dict(self.ITEMS[0])])
        out = self.client.get("/bills/INV-1/items", headers=self.headers).get_json()
        self.assertEqual(out[0]["tax_percentage"], 3.0)

    def test_two_identical_lines_each_use_their_own_snapshot(self):
        self.turn_on(bills_read=True)
        line = {"productid": "p1", "quantity": 1, "price": 10.0, "total": 10.0, "products": {}}
        self.siri.routes[("GET", "/api/store/bills/INV-1/items")] = (200, [dict(line, id=1), dict(line, id=2)])
        self.snapshots = [dict(line, tax_percentage=5.0, hsn_code="A"), dict(line, tax_percentage=12.0, hsn_code="B")]
        out = self.client.get("/bills/INV-1/items", headers=self.headers).get_json()
        self.assertEqual([o["hsn_code"] for o in out], ["A", "B"])

    def test_edit_payload_gets_saved_tax_and_a_409_passes_through(self):
        self.turn_on(bills_read=True)
        self.siri.routes[("GET", "/api/store/bills/INV-1/edit-payload")] = (200, {
            "bill": {"id": "INV-1"}, "can_edit": True,
            "items": [{"id": 1, "productId": "p1", "name": "Unknown Item", "quantity": 2, "price": 100.0, "total": 200.0,
                       "barcodes": "", "taxPercentage": 3.0, "hsnCode": ""}]})
        self.snapshots = [{"productid": "p1", "quantity": 2, "price": 100.0, "total": 200.0, "tax_percentage": 5.0,
                           "hsn_code": "9999", "name": "Ring", "barcode": "B1"}]
        out = self.client.get("/bills/INV-1/edit-payload", headers=self.headers).get_json()
        item = out["items"][0]
        self.assertEqual((item["taxPercentage"], item["hsnCode"], item["name"], item["barcodes"]), (5.0, "9999", "Ring", "B1"))
        self.siri.routes[("GET", "/api/store/bills/INV-1/edit-payload")] = (409, {"message": "expired", "can_edit": False})
        r = self.client.get("/bills/INV-1/edit-payload", headers=self.headers)
        self.assertEqual((r.status_code, r.get_json()["can_edit"]), (409, False))

    def test_a_broken_overlay_falls_back_to_the_old_code(self):
        self.turn_on(bills_read=True)
        self.siri.routes[("GET", "/api/store/bills/INV-1/items")] = (200, [dict(self.ITEMS[0])])
        with mock.patch.object(views, "_buckets", side_effect=RuntimeError("snapshot file broken")):
            self.client.get("/bills/INV-1/items", headers=self.headers)
        self.assertTrue(self.old_path_ran())


class WriteTests(BillViewsBase):
    REVISE = {"store_id": "s1", "items": [
        {"product_id": "p1", "quantity": 2, "unit_price": 100, "item_total": 200, "tax_percentage": 5, "hsn_code": "9999", "name": "Ring"},
        {"productId": "p2", "quantity": 1, "price": 50},
        {"product_id": "p3", "quantity": 0, "price": 5}]}

    def test_switch_off_old_code_runs_for_every_write(self):
        self.turn_on(bills_read=True, bills_write=False)
        self.client.post("/bills/INV-1/cancel", json={}, headers=self.headers)
        self.client.put("/bills/INV-1/revise", json=self.REVISE, headers=self.headers)
        self.assertTrue(self.old_path_ran())
        self.assertEqual([c for c in self.siri_calls() if c.method != "GET"], [])

    def test_cancel_goes_to_siri_api_and_refreshes_the_product_cache(self):
        self.turn_on(bills_write=True)
        self.siri.routes[("POST", "/api/store/bills/INV-1/cancel")] = (200, {"message": "Invoice cancelled successfully", "bill_id": "INV-1"})
        r = self.client.post("/bills/INV-1/cancel", json={"cancel_reason": "wrong item"}, headers=self.headers)
        self.assertEqual((r.status_code, r.get_json()["bill_id"]), (200, "INV-1"))
        self.assertFalse(self.old_path_ran())
        sent = [c for c in self.siri_calls() if c.method == "POST"][0]
        self.assertIn(b"wrong item", sent.content)
        self.invalidate.assert_called()

    def test_legacy_delete_is_a_cancel_through_siri_api(self):
        self.turn_on(bills_write=True)
        self.siri.routes[("DELETE", "/api/store/bills/INV-1")] = (200, {"message": "Invoice cancelled successfully"})
        r = self.client.delete("/bills/INV-1", headers=self.headers)
        self.assertEqual(r.status_code, 200)
        self.assertFalse(self.old_path_ran())
        self.invalidate.assert_called()

    def test_update_goes_to_siri_api(self):
        self.turn_on(bills_write=True)
        self.siri.routes[("PUT", "/api/store/bills/INV-1")] = (200, {"id": "INV-1", "paymentmethod": "UPI"})
        r = self.client.put("/bills/INV-1", json={"paymentmethod": "UPI"}, headers=self.headers)
        self.assertEqual(r.get_json()["paymentmethod"], "UPI")
        self.assertFalse(self.old_path_ran())

    def test_revise_goes_to_siri_api_then_replaces_the_receipt_detail(self):
        self.turn_on(bills_write=True)
        self.siri.routes[("PUT", "/api/store/bills/INV-1/revise")] = (200, {"message": "Invoice revised successfully", "bill_id": "INV-1"})
        r = self.client.put("/bills/INV-1/revise", json=self.REVISE, headers=self.headers)
        self.assertEqual(r.status_code, 200)
        self.assertFalse(self.old_path_ran())
        bill_id, rows = self.replace_snapshots.call_args[0]
        self.assertEqual(bill_id, "INV-1")
        self.assertEqual([(x["productid"], x["quantity"], x["price"], x["total"]) for x in rows],
                         [("p1", 2, 100.0, 200.0), ("p2", 1, 50.0, 50.0)])            # the zero-quantity line is dropped
        self.assertEqual((rows[0]["tax_percentage"], rows[0]["hsn_code"]), (5.0, "9999"))
        self.assertNotIn("tax_percentage", rows[1])                                    # unknown: siri-api's live tax shows
        self.invalidate.assert_called()
        self.publish.assert_called()

    def test_a_refused_revise_is_returned_and_changes_nothing_locally(self):
        self.turn_on(bills_write=True)
        self.siri.routes[("PUT", "/api/store/bills/INV-1/revise")] = (409, {"message": "locked by a replacement"})
        r = self.client.put("/bills/INV-1/revise", json=self.REVISE, headers=self.headers)
        self.assertEqual((r.status_code, r.get_json()["message"]), (409, "locked by a replacement"))
        self.assertFalse(self.old_path_ran())
        self.replace_snapshots.assert_not_called()
        self.invalidate.assert_not_called()

    def test_a_lost_answer_is_never_repeated_down_the_old_path(self):
        self.turn_on(bills_write=True)
        for failure in (httpx.ReadTimeout("slow"), httpx.RemoteProtocolError("dropped")):
            self.siri.fail = failure
            for r in (self.client.post("/bills/INV-1/cancel", json={}, headers=self.headers),
                      self.client.put("/bills/INV-1/revise", json=self.REVISE, headers=self.headers)):
                self.assertEqual((r.status_code, r.get_json()["code"], r.get_json()["retryable"]), (503, "siri_unclear", True))
        self.siri.fail = None
        self.siri.routes[("POST", "/api/store/bills/INV-1/cancel")] = (500, {"message": "boom"})
        self.assertEqual(self.client.post("/bills/INV-1/cancel", json={}, headers=self.headers).status_code, 503)
        self.assertFalse(self.old_path_ran())
        self.replace_snapshots.assert_not_called()

    def test_a_refused_connection_never_reached_siri_api_so_the_old_path_runs(self):
        self.turn_on(bills_write=True)
        self.siri.fail = httpx.ConnectError("refused")
        self.client.post("/bills/INV-1/cancel", json={}, headers=self.headers)
        self.assertTrue(self.old_path_ran())

    def test_a_refused_token_lets_the_old_path_run(self):
        self.turn_on(bills_write=True)
        self.siri.routes[("POST", "/api/store/bills/INV-1/cancel")] = (401, {"message": "expired"})
        self.client.post("/bills/INV-1/cancel", json={}, headers=self.headers)
        self.assertTrue(self.old_path_ran())

    def test_a_failing_local_follow_up_never_fails_the_answer(self):
        self.turn_on(bills_write=True)
        self.siri.routes[("PUT", "/api/store/bills/INV-1/revise")] = (200, {"message": "ok", "bill_id": "INV-1"})
        self.replace_snapshots.side_effect = OSError("disk full")
        self.invalidate.side_effect = OSError("cache gone")
        self.assertEqual(self.client.put("/bills/INV-1/revise", json=self.REVISE, headers=self.headers).status_code, 200)

    def test_a_different_cashier_than_siri_api_knows_gets_the_old_code(self):
        self.turn_on(bills_write=True)
        with self.client.application.app_context():
            other = {"Authorization": "Bearer " + create_access_token(identity="cashier-2")}
        self.client.post("/bills/INV-1/cancel", json={}, headers=other)
        self.assertEqual([c for c in self.siri_calls() if c.method == "POST"], [])


class RevisedSnapshotTests(unittest.TestCase):
    def test_lines_follow_the_same_rules_as_siri_api(self):
        rows = views.revised_snapshots({"items": [
            {"product_id": "p1", "quantity": "3", "unitPrice": "10.5"},
            {"productId": "p2", "quantity": 1, "price": 5, "total": 4},
            {"quantity": 2, "price": 5}, {"product_id": "p4", "quantity": -1}, "junk", None]})
        self.assertEqual([(r["productid"], r["quantity"], r["price"], r["total"]) for r in rows],
                         [("p1", 3, 10.5, 31.5), ("p2", 1, 5.0, 4.0)])

    def test_nothing_in_nothing_out(self):
        self.assertEqual(views.revised_snapshots({}), [])
        self.assertEqual(views.revised_snapshots(None), [])


if __name__ == "__main__":
    unittest.main()
