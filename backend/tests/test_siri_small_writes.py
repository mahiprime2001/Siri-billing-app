"""
Customer create/edit and notification mark-as-read through siri-api (switch group `small_writes`).

  * switch off / no siri session -> the old code runs, no network call;
  * switch on -> siri-api answers (a real "no", such as an edit conflict, is returned as it is);
  * customer create/edit that may have been done but whose answer was lost is NOT repeated down the old path
    (a repeat would make a second customer); a refused connection / refused token does fall back;
  * mark-as-read is harmless to repeat, so any trouble simply falls back to the old code.

Run from the backend folder:
    .venv\\Scripts\\python.exe -m unittest tests.test_siri_small_writes -v
"""
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

import routes.customer_routes as customers  # noqa: E402
import routes.notification_routes as notifications  # noqa: E402
import routes.settings_routes as settings  # noqa: E402
import routes.user_routes as users  # noqa: E402
from tests.test_siri_api import ClientBase, switches_body  # noqa: E402
from utils import siri_api  # noqa: E402


class SmallWritesBase(ClientBase):
    def setUp(self):
        super().setUp()
        siri_api._client = self.api
        app = Flask(__name__)
        app.config["JWT_SECRET_KEY"] = "test-secret-that-is-long-enough-for-hmac-sha256"
        JWTManager(app)
        app.register_blueprint(customers.customer_bp)
        app.register_blueprint(notifications.notification_bp)
        app.register_blueprint(settings.settings_bp)
        app.register_blueprint(users.user_bp)
        self.client = app.test_client()
        with app.app_context():
            self.headers = {"Authorization": "Bearer " + create_access_token(identity="cashier-1")}
            self.other = {"Authorization": "Bearer " + create_access_token(identity="cashier-2")}
        self.old_db = mock.MagicMock(name="old_db")
        user_ok = mock.MagicMock()
        user_ok.table.return_value.select.return_value.eq.return_value.execute.return_value.data = [{"id": "x"}]
        for p in (mock.patch("auth.auth.get_supabase_client", return_value=user_ok),
                  mock.patch.object(customers, "get_supabase_client", return_value=self.old_db),
                  mock.patch.object(notifications, "get_supabase_client", return_value=self.old_db),
                  mock.patch.object(settings, "get_supabase_client", return_value=self.old_db),
                  mock.patch.object(users, "get_supabase_client", return_value=self.old_db)):
            p.start()
        self.addCleanup(mock.patch.stopall)

    def tearDown(self):
        siri_api._client = None
        super().tearDown()

    def turn_on(self, **groups):
        self.siri.routes[("GET", "/api/store/config")] = switches_body(**groups)
        self.login()
        self.api.switches()          # fetched now: with the network broken later, unknown switches would mean "off"

    def old_path_ran(self):
        return self.old_db.table.call_count > 0

    def posts(self):
        return [c for c in self.siri.calls if c.method in ("POST", "PUT") and c.url.path.startswith("/api/store")]


class CustomerTests(SmallWritesBase):
    def test_switch_off_means_old_code_and_no_siri_call(self):
        self.turn_on(small_writes=False)
        self.client.post("/customers", json={"name": "Asha"}, headers=self.headers)
        self.client.put("/customers/C1", json={"name": "A", "baseVersion": 1}, headers=self.headers)
        self.assertTrue(self.old_path_ran())
        self.assertEqual(self.posts(), [])

    def test_no_session_means_old_code(self):
        self.client.post("/customers", json={"name": "Asha"}, headers=self.headers)
        self.assertTrue(self.old_path_ran())
        self.assertEqual(self.siri.calls, [])

    def test_create_and_edit_go_to_siri_api(self):
        self.turn_on(small_writes=True)
        self.siri.routes[("POST", "/api/store/customers")] = (201, {"id": "CUST-1", "name": "Asha"})
        self.siri.routes[("PUT", "/api/store/customers/CUST-1")] = (200, {"id": "CUST-1", "name": "Asha K", "version": 2})
        r = self.client.post("/customers", json={"name": "Asha", "phone": "99"}, headers=self.headers)
        self.assertEqual((r.status_code, r.get_json()["id"]), (201, "CUST-1"))
        r = self.client.put("/customers/CUST-1", json={"name": "Asha K", "baseVersion": 1}, headers=self.headers)
        self.assertEqual((r.status_code, r.get_json()["version"]), (200, 2))
        self.assertFalse(self.old_path_ran())
        self.assertIn(b'"phone"', self.posts()[0].content)
        self.assertIn(b"baseVersion", self.posts()[1].content)

    def test_an_edit_conflict_is_returned_as_it_is(self):
        self.turn_on(small_writes=True)
        self.siri.routes[("PUT", "/api/store/customers/C1")] = (409, {"message": "Update conflict", "latest": {"id": "C1"}})
        r = self.client.put("/customers/C1", json={"name": "A", "baseVersion": 1}, headers=self.headers)
        self.assertEqual((r.status_code, r.get_json()["latest"]), (409, {"id": "C1"}))
        self.assertFalse(self.old_path_ran())

    def test_a_lost_answer_is_not_repeated_down_the_old_path(self):
        self.turn_on(small_writes=True)
        for failure in (httpx.ReadTimeout("slow"), httpx.RemoteProtocolError("dropped")):
            self.siri.fail = failure
            for r in (self.client.post("/customers", json={"name": "Asha"}, headers=self.headers),
                      self.client.put("/customers/C1", json={"name": "A", "baseVersion": 1}, headers=self.headers)):
                self.assertEqual((r.status_code, r.get_json()["code"]), (503, "siri_unclear"))
        self.assertFalse(self.old_path_ran())

    def test_a_server_fault_is_not_repeated_either(self):
        self.turn_on(small_writes=True)
        self.siri.routes[("POST", "/api/store/customers")] = (500, {"message": "boom"})
        self.assertEqual(self.client.post("/customers", json={"name": "Asha"}, headers=self.headers).status_code, 503)
        self.assertFalse(self.old_path_ran())

    def test_refused_connection_or_token_falls_back(self):
        self.turn_on(small_writes=True)
        self.siri.fail = httpx.ConnectError("refused")
        self.client.post("/customers", json={"name": "Asha"}, headers=self.headers)
        self.assertTrue(self.old_path_ran())
        self.old_db.reset_mock()
        self.siri.fail = None
        self.siri.routes[("POST", "/api/store/customers")] = (401, {"message": "expired"})
        self.client.post("/customers", json={"name": "Asha"}, headers=self.headers)
        self.assertTrue(self.old_path_ran())

    def test_other_cashier_gets_the_old_code_and_delete_is_never_forwarded(self):
        self.turn_on(small_writes=True)
        self.client.post("/customers", json={"name": "Asha"}, headers=self.other)
        self.client.delete("/customers/C1", headers=self.headers)
        self.assertEqual(self.posts(), [])
        self.assertTrue(self.old_path_ran())


class NotificationTests(SmallWritesBase):
    def test_switch_off_means_old_code(self):
        self.turn_on(small_writes=False)
        self.client.post("/notifications/7/read", headers=self.headers)
        self.client.post("/notifications/read-all", headers=self.headers)
        self.assertTrue(self.old_path_ran())
        self.assertEqual(self.posts(), [])

    def test_mark_read_and_read_all_go_to_siri_api(self):
        self.turn_on(small_writes=True)
        self.siri.routes[("POST", "/api/store/notifications/7/read")] = (200, {"id": 7, "is_read": True})
        self.siri.routes[("POST", "/api/store/notifications/read-all")] = (200, {"message": "All notifications marked as read", "updated": 3})
        self.assertEqual(self.client.post("/notifications/7/read", headers=self.headers).get_json()["is_read"], True)
        self.assertEqual(self.client.post("/notifications/read-all", headers=self.headers).get_json()["updated"], 3)
        self.assertFalse(self.old_path_ran())

    def test_a_not_found_is_returned_as_it_is(self):
        self.turn_on(small_writes=True)
        self.siri.routes[("POST", "/api/store/notifications/7/read")] = (404, {"message": "Notification not found"})
        self.assertEqual(self.client.post("/notifications/7/read", headers=self.headers).status_code, 404)
        self.assertFalse(self.old_path_ran())

    def test_any_trouble_just_falls_back_because_repeating_is_harmless(self):
        self.turn_on(small_writes=True)
        self.siri.fail = httpx.ReadTimeout("slow")
        self.client.post("/notifications/7/read", headers=self.headers)
        self.assertTrue(self.old_path_ran())
        self.old_db.reset_mock()
        self.siri.fail = None
        self.siri.routes[("POST", "/api/store/notifications/read-all")] = (500, {})
        self.client.post("/notifications/read-all", headers=self.headers)
        self.assertTrue(self.old_path_ran())


class FormerlyDirectRoutesTests(SmallWritesBase):
    """User read/edit, company settings edit and customer delete used to write straight to the database with the
    PC's master key. They now go through siri-api (which adds the store / admin / has-bills checks)."""

    def test_switch_off_means_old_code_and_no_siri_call(self):
        self.turn_on(small_writes=False, reads=False)
        self.client.get("/users/u1", headers=self.headers)
        self.client.put("/users/u1", json={"name": "A", "baseVersion": 1}, headers=self.headers)
        self.client.put("/settings", json={"companyName": "X", "baseVersion": 1}, headers=self.headers)
        self.client.delete("/customers/C1", headers=self.headers)
        self.assertTrue(self.old_path_ran())
        self.assertEqual([c for c in self.siri.calls if c.url.path.startswith("/api/store/") and c.method != "GET" or "/users/" in c.url.path], [])

    def test_all_four_go_to_siri_api_and_its_refusals_are_shown_as_they_are(self):
        self.turn_on(small_writes=True, reads=True)
        self.siri.routes[("GET", "/api/store/users/u1")] = (200, {"id": "u1", "name": "Asha"})
        self.siri.routes[("PUT", "/api/store/users/u1")] = (200, {"id": "u1", "name": "Asha K"})
        self.siri.routes[("PUT", "/api/store/users/u2")] = (403, {"message": "You can only change your own profile here"})
        self.siri.routes[("PUT", "/api/store/settings")] = (403, {"message": "Only an admin can change company settings"})
        self.siri.routes[("DELETE", "/api/store/customers/C1")] = (409, {"code": "has_bills"})
        self.siri.routes[("DELETE", "/api/store/customers/C2")] = (200, {"message": "Customer deleted successfully"})
        self.assertEqual(self.client.get("/users/u1", headers=self.headers).get_json()["name"], "Asha")
        self.assertEqual(self.client.put("/users/u1", json={"name": "Asha K", "baseVersion": 1}, headers=self.headers).status_code, 200)
        self.assertEqual(self.client.put("/users/u2", json={"name": "X", "baseVersion": 1}, headers=self.headers).status_code, 403)
        self.assertEqual(self.client.put("/settings", json={"companyName": "X", "baseVersion": 1}, headers=self.headers).status_code, 403)
        self.assertEqual(self.client.delete("/customers/C1", headers=self.headers).get_json()["code"], "has_bills")
        self.assertEqual(self.client.delete("/customers/C2", headers=self.headers).status_code, 200)
        self.assertFalse(self.old_path_ran())                       # siri-api's "no" is never overridden by the old code

    def test_a_lost_answer_is_not_repeated_down_the_old_path(self):
        self.turn_on(small_writes=True, reads=True)
        self.siri.fail = httpx.ReadTimeout("slow")
        for r in (self.client.put("/users/u1", json={"name": "A", "baseVersion": 1}, headers=self.headers),
                  self.client.put("/settings", json={"companyName": "X", "baseVersion": 1}, headers=self.headers),
                  self.client.delete("/customers/C2", headers=self.headers)):
            self.assertEqual((r.status_code, r.get_json()["code"]), (503, "siri_unclear"))
        self.assertFalse(self.old_path_ran())


if __name__ == "__main__":
    unittest.main()
