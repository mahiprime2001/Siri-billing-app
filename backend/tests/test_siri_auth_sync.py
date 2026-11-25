"""
Login, the per-request user check and the background copy through siri-api (switch groups `auth` and `sync`).

  * auth off -> the old login (unchanged);
  * auth on  -> siri-api checks the password; a wrong password is refused (never retried the old way); with no
                internet the scrambled copy of the last accepted password lets the cashier in; the real password is
                never written to disk;
  * sync on  -> the background copy comes from siri-api; a table siri-api cannot give still comes the old way.

Run from the backend folder:  .venv\\Scripts\\python.exe -m unittest tests.test_siri_auth_sync -v
"""
import os
import sys
import tempfile
import unittest
from unittest import mock

import httpx

BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND not in sys.path:
    sys.path.insert(0, BACKEND)

from flask import Flask  # noqa: E402
from flask_jwt_extended import JWTManager  # noqa: E402

import routes.auth_routes as auth_routes  # noqa: E402
from tests.test_siri_api import ClientBase, switches_body  # noqa: E402
from utils import offline_credentials, siri_api  # noqa: E402


class AuthBase(ClientBase):
    def setUp(self):
        super().setUp()
        siri_api._client = self.api
        self.json_dir = tempfile.mkdtemp(prefix="creds-")
        p = mock.patch.object(offline_credentials, "JSON_DIR", self.json_dir)
        p.start()
        self.addCleanup(p.stop)
        app = Flask(__name__)
        app.config["JWT_SECRET_KEY"] = "test-secret-that-is-long-enough-for-hmac-sha256"
        app.config["JWT_TOKEN_LOCATION"] = ["headers", "cookies"]
        JWTManager(app)
        app.register_blueprint(auth_routes.auth_bp)
        self.client = app.test_client()
        self.old_db = mock.MagicMock(name="old_db")
        self.old_db.is_offline_fallback = False        # the real database client (a MagicMock would say "yes")
        self.old_db.table.return_value.select.return_value.eq.return_value.execute.return_value.data = [
            {"id": "cashier-1", "email": "a@x.com", "password": "pw", "name": "Asha", "role": "billing_user"}]
        p = mock.patch.object(auth_routes, "get_supabase_client", return_value=self.old_db)
        p.start()
        self.addCleanup(p.stop)
        p = mock.patch.object(self.api, "login_in_background", lambda *a, **k: None)
        p.start()
        self.addCleanup(p.stop)

    def tearDown(self):
        siri_api._client = None
        super().tearDown()

    def turn_on(self, **groups):
        self.siri.routes[("GET", "/api/store/config")] = switches_body(**groups)
        self.login()
        self.api.switches(force=True)

    def post_login(self, password="pw"):
        return self.client.post("/login", json={"email": "a@x.com", "password": password})

    def old_db_asked(self):
        return self.old_db.table.call_count > 0 or self.old_db.from_.call_count > 0   # login uses table(), sync from_()


class LoginTests(AuthBase):
    def test_switch_off_means_the_old_login(self):
        self.turn_on(auth=False)
        r = self.post_login()
        self.assertEqual(r.status_code, 200)
        self.assertTrue(self.old_db_asked())

    def test_switch_on_siri_api_checks_the_password_and_the_database_is_not_asked(self):
        self.turn_on(auth=True)
        r = self.post_login()
        self.assertEqual((r.status_code, r.get_json()["user"]["id"]), (200, "cashier-1"))
        self.assertFalse(self.old_db_asked())

    def test_a_wrong_password_is_refused_and_never_tried_the_old_way(self):
        self.turn_on(auth=True)
        self.siri.routes[("POST", "/api/auth/login")] = (401, {"error": "Invalid credentials"})
        self.assertEqual(self.post_login("wrong").status_code, 401)
        self.assertFalse(self.old_db_asked())

    def test_offline_the_scrambled_copy_lets_the_cashier_in_and_holds_no_real_password(self):
        self.turn_on(auth=True)
        self.assertEqual(self.post_login().status_code, 200)               # online: siri-api accepts, copy kept
        raw = open(os.path.join(self.json_dir, "offline_credentials.json"), encoding="utf-8").read()
        self.assertNotIn('"pw"', raw)
        self.siri.fail = httpx.ConnectError("no internet")
        r = self.post_login()
        self.assertEqual((r.status_code, r.get_json()["user"]["id"]), (200, "cashier-1"))
        self.assertFalse(self.old_db_asked())

    def test_offline_a_wrong_password_does_not_match_the_copy(self):
        self.turn_on(auth=True)
        self.post_login()
        self.assertIsNone(offline_credentials.check("a@x.com", "wrong"))
        self.assertIsNotNone(offline_credentials.check("a@x.com", "pw"))

    def test_a_refused_password_also_removes_the_offline_copy(self):
        self.turn_on(auth=True)
        self.post_login()
        self.siri.routes[("POST", "/api/auth/login")] = (401, {"error": "Invalid credentials"})
        self.post_login("changed-elsewhere")
        self.assertIsNone(offline_credentials.check("a@x.com", "pw"))

    def test_nellore_25_nov_switches_gone_stale_offline_the_copy_still_lets_the_cashier_in(self):
        """Copy saved online; later the app sees `auth` as off (stale switches), the internet is down and the local
        user list has no passwords. Before the fix: 16x "invalid password". Now: the copy is used."""
        self.turn_on(auth=True)
        self.assertEqual(self.post_login().status_code, 200)                # online: copy saved
        self.turn_on(auth=False)                                             # switches look off now
        self.siri.fail = httpx.ConnectError("getaddrinfo failed")
        self.old_db.table.return_value.select.return_value.eq.return_value.execute.side_effect = Exception("getaddrinfo failed")
        started = []
        with mock.patch.object(self.api, "keep_trying_login", lambda e, p, **k: started.append(e)),              mock.patch.object(auth_routes, "_find_local_user_by_email",
                               return_value={"id": "cashier-1", "email": "a@x.com", "name": "Asha", "role": "billing_user"}):
            r = self.post_login()
            self.assertEqual((r.status_code, r.get_json()["user"]["id"]), (200, "cashier-1"))
            self.assertEqual(self.post_login("wrong").status_code, 401)
        self.assertEqual(started, ["a@x.com"])                               # the siri-api login is retried later

    def test_the_local_offline_stand_in_counts_as_no_internet_too(self):
        self.turn_on(auth=True)
        self.post_login()
        self.turn_on(auth=False)
        self.siri.fail = httpx.ConnectError("no internet")
        stand_in = mock.MagicMock(name="offline_stand_in", is_offline_fallback=True)
        stand_in.table.return_value.select.return_value.eq.return_value.execute.return_value.data = [
            {"id": "cashier-1", "email": "a@x.com", "name": "Asha", "role": "billing_user"}]          # no password left
        with mock.patch.object(auth_routes, "get_supabase_client", return_value=stand_in),              mock.patch.object(self.api, "keep_trying_login", lambda *a, **k: None):
            self.assertEqual(self.post_login().status_code, 200)

    def test_online_the_copy_is_never_used_instead_of_the_real_check(self):
        self.turn_on(auth=True)
        self.post_login()
        self.turn_on(auth=False)
        self.old_db.table.return_value.select.return_value.eq.return_value.execute.return_value.data = [
            {"id": "cashier-1", "email": "a@x.com", "password": "new-password", "role": "billing_user"}]
        self.assertEqual(self.post_login("pw").status_code, 401)            # database reachable: its answer stands

    def test_offline_with_no_copy_falls_back_to_the_old_way_until_the_lockdown(self):
        self.turn_on(auth=True)
        self.siri.fail = httpx.ConnectError("no internet")
        self.assertEqual(self.post_login().status_code, 200)
        self.assertTrue(self.old_db_asked())


class RequestCheckTests(AuthBase):
    """With `auth` on, "does this signed-in person still exist?" is answered locally (no database call per request)."""

    def setUp(self):
        super().setUp()
        from flask_jwt_extended import create_access_token
        from auth import auth as auth_mod
        app = Flask(__name__)
        app.config["JWT_SECRET_KEY"] = "test-secret-that-is-long-enough-for-hmac-sha256"
        JWTManager(app)

        @app.route("/ping")
        @auth_mod.require_auth
        def ping():
            return "ok"

        self.app = app

        def tok(uid):
            with app.app_context():
                return {"Authorization": "Bearer " + create_access_token(identity=uid)}
        self.tok = tok
        self.users_file = os.path.join(self.json_dir, "users.json")
        p = mock.patch("config.config.USERS_FILE", self.users_file)
        p.start()
        self.addCleanup(p.stop)
        p = mock.patch.object(auth_mod, "get_supabase_client", return_value=self.old_db)
        p.start()
        self.addCleanup(p.stop)

    def users(self, ids):
        import json
        with open(self.users_file, "w", encoding="utf-8") as f:
            json.dump([{"id": i} for i in ids], f)

    def test_a_person_of_this_store_passes_without_asking_the_database(self):
        self.turn_on(auth=True)
        self.users(["cashier-1", "cashier-2"])
        c = self.app.test_client()
        self.assertEqual(c.get("/ping", headers=self.tok("cashier-2")).status_code, 200)
        self.assertFalse(self.old_db_asked())

    def test_someone_removed_from_the_store_is_turned_away(self):
        self.turn_on(auth=True)
        self.users(["cashier-1"])
        self.assertEqual(self.app.test_client().get("/ping", headers=self.tok("gone")).status_code, 404)

    def test_with_no_local_list_yet_a_signed_in_person_is_trusted(self):
        self.turn_on(auth=True)
        self.assertEqual(self.app.test_client().get("/ping", headers=self.tok("cashier-1")).status_code, 200)


class SyncTests(AuthBase):
    def setUp(self):
        super().setUp()
        from utils import sync_controller as sc
        self.controller = sc.SyncController()
        p = mock.patch.object(sc, "get_supabase_client", return_value=self.old_db)
        p.start()
        self.addCleanup(p.stop)

    def test_sync_on_the_copy_comes_from_siri_api(self):
        self.turn_on(sync=True)
        self.siri.routes[("GET", "/api/store/sync/Users")] = (200, {"rows": [{"id": "cashier-1", "name": "Asha"}],
                                                                   "sync_timestamp": "2026-11-23T10:00:00"})
        out = self.controller.pull_sync(last_sync=None, tables=["Users"])
        self.assertEqual(out["data"]["Users"], [{"id": "cashier-1", "name": "Asha"}])
        self.assertEqual(out["sync_timestamp"], "2026-11-23T10:00:00")
        self.assertFalse(self.old_db_asked())

    def test_sync_off_means_the_old_copy(self):
        self.turn_on(sync=False)
        self.controller.pull_sync(last_sync=None, tables=["Users"])
        self.assertTrue(self.old_db_asked())

    def test_old_plain_text_passwords_are_removed_from_the_local_user_list(self):
        import json
        from background_tasks import background_tasks as bt
        path = os.path.join(self.json_dir, "users.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump([{"id": "cashier-1", "password": "pw"}, {"id": "cashier-2"}], f)
        bt._drop_local_passwords(path)
        with open(path, encoding="utf-8") as f:
            self.assertEqual(json.load(f), [{"id": "cashier-1"}, {"id": "cashier-2"}])

    def test_a_table_siri_api_cannot_give_still_comes_the_old_way(self):
        self.turn_on(sync=True)
        self.siri.routes[("GET", "/api/store/sync/Bills")] = (503, {"code": "database_unavailable"})
        self.controller.pull_sync(last_sync=None, tables=["Bills"])
        self.assertTrue(self.old_db_asked())


if __name__ == "__main__":
    unittest.main()
