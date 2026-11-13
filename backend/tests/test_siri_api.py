"""
The store app's siri-api client and the @via_siri_api switch: nothing changes while switches are off, siri-api
trouble always falls back to the old path, a real "no" from siri-api is never overridden by the old path, only
reads are forwarded, and the cashier siri-api knows must be the cashier who is asking.

A fake siri-api answers (httpx.MockTransport); nothing touches the network.
Run from the backend folder:   .venv\\Scripts\\python.exe -m unittest tests.test_siri_api -v
"""
import os
import sys
import tempfile
import threading
import unittest

import httpx

BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND not in sys.path:
    sys.path.insert(0, BACKEND)

from flask import Flask, jsonify  # noqa: E402
from flask_jwt_extended import JWTManager, create_access_token, jwt_required  # noqa: E402

from utils import siri_api  # noqa: E402
from utils.siri_api import GROUPS, SiriApi  # noqa: E402
from utils.siri_proxy import current_store_from_me, via_siri_api  # noqa: E402


class FakeSiri:
    """A scripted siri-api. `routes` maps (method, path) -> (status, body[, headers])."""

    def __init__(self):
        self.routes, self.calls = {}, []
        self.fail = None          # an exception to raise instead of answering (a dead network)

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        if self.fail:
            raise self.fail
        route = self.routes.get((request.method, request.url.path))
        if route is None:
            return httpx.Response(404, json={"message": "no such route"})
        status, body = route[0], route[1]
        headers = route[2] if len(route) > 2 else {}
        return httpx.Response(status, json=body, headers=headers)

    def transport(self):
        return httpx.MockTransport(self.handler)


LOGIN_OK = (200, {"auth_ok": True, "access_token": "tok-1", "user_role": "billing_user",
                  "user": {"id": "cashier-1", "name": "Asha"}, "store_ids": ["s1"], "replay_tokens": {"s1": "replay-s1"}})


def switches_body(**on):
    return (200, {"storeId": "s1", "switches": {g: on.get(g, False) for g in GROUPS}})


class ClientBase(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="siri-client-test-")
        self.siri = FakeSiri()
        self.now = [1000.0]
        os.environ.pop("SIRI_API_DISABLE", None)
        self.api = self.make()

    def make(self):
        return SiriApi(base_url="https://siri.test", data_dir=self.dir, transport=self.siri.transport(), clock=lambda: self.now[0])

    def login(self):
        self.siri.routes[("POST", "/api/auth/login")] = LOGIN_OK
        self.assertTrue(self.api.login("a@x.com", "pw"))

    def config_asks(self):
        return len([c for c in self.siri.calls if c.url.path == "/api/store/config"])

    def tearDown(self):
        os.environ.pop("SIRI_API_DISABLE", None)


class LoginTests(ClientBase):
    def test_a_good_login_keeps_the_token_and_the_replay_passes_and_survives_a_restart(self):
        self.login()
        self.assertTrue(self.api.has_session())
        self.assertEqual(self.api.session_user_id(), "cashier-1")
        self.assertEqual(self.api.replay_token("s1"), "replay-s1")
        self.assertEqual(self.api.store_ids(), ["s1"])
        again = self.make()                                        # the app was restarted: the session is remembered
        self.assertTrue(again.has_session())
        self.assertEqual(again.replay_token("s1"), "replay-s1")

    def test_a_refused_login_keeps_nothing(self):
        self.siri.routes[("POST", "/api/auth/login")] = (401, {"error": "Invalid credentials", "auth_ok": False})
        self.assertFalse(self.api.login("a@x.com", "bad"))
        self.assertFalse(self.api.has_session())

    def test_a_dead_network_is_just_a_false_never_an_exception(self):
        self.siri.fail = httpx.ConnectError("no internet")
        self.assertFalse(self.api.login("a@x.com", "pw"))
        self.assertFalse(self.api.has_session())

    def test_a_failed_login_does_not_wipe_a_session_that_already_exists(self):
        self.login()
        self.siri.routes[("POST", "/api/auth/login")] = (500, {"error": "boom"})
        self.assertFalse(self.api.login("a@x.com", "pw"))
        self.assertTrue(self.api.has_session())
        self.assertEqual(self.api.replay_token("s1"), "replay-s1")

    def test_a_damaged_session_file_means_no_session_not_a_crash(self):
        with open(os.path.join(self.dir, "siri_session.json"), "w", encoding="utf-8") as f:
            f.write("{broken")
        self.assertFalse(self.make().has_session())

    def test_the_background_login_never_raises_and_does_the_login(self):
        self.siri.routes[("POST", "/api/auth/login")] = LOGIN_OK
        self.siri.routes[("GET", "/api/store/config")] = switches_body(reads=True)
        self.api.login_in_background("a@x.com", "pw")
        for t in threading.enumerate():
            if t.name == "siri-api-login":
                t.join(5)
        self.assertTrue(self.api.has_session())
        self.assertTrue(self.api.enabled("reads"))


class RequestTests(ClientBase):
    def test_no_session_means_unavailable_without_any_network_call(self):
        r = self.api.request("GET", "/api/store/products")
        self.assertTrue(r.unavailable)
        self.assertEqual(self.siri.calls, [])

    def test_the_cashiers_token_is_sent_and_a_renewed_token_replaces_it(self):
        self.login()
        self.siri.routes[("GET", "/api/store/products")] = (200, [], {"X-Access-Token": "tok-2"})
        self.api.request("GET", "/api/store/products")
        self.assertEqual(self.siri.calls[-1].headers["authorization"], "Bearer tok-1")
        self.api.request("GET", "/api/store/products")
        self.assertEqual(self.siri.calls[-1].headers["authorization"], "Bearer tok-2")
        self.assertEqual(self.make().session_user_id(), "cashier-1")        # remembered, and the user is intact

    def test_a_401_drops_the_token_but_keeps_the_replay_passes(self):
        self.login()
        self.siri.routes[("GET", "/api/store/products")] = (401, {"error": "expired"})
        r = self.api.request("GET", "/api/store/products")
        self.assertTrue(r.unavailable)
        self.assertFalse(self.api.has_session())
        self.assertEqual(self.api.replay_token("s1"), "replay-s1")

    def test_a_replay_request_uses_the_stores_replay_pass(self):
        self.login()
        self.siri.routes[("POST", "/api/store/replay/bills")] = (201, {"bill_id": "B1"})
        r = self.api.request("POST", "/api/store/replay/bills", json_body={"x": 1}, replay=True, store_id="s1")
        self.assertEqual(r.status, 201)
        self.assertEqual(self.siri.calls[-1].headers["authorization"], "Bearer replay-s1")
        self.assertTrue(self.api.request("POST", "/api/store/replay/bills", replay=True, store_id="other").unavailable)

    def test_what_counts_as_unavailable(self):
        for status, expect in ((200, False), (404, False), (403, False), (400, False), (409, False), (429, False),
                               (500, True), (502, True), (503, True), (401, True)):
            self.login()                                            # a 401 drops the token: log in afresh each time
            self.siri.routes[("GET", "/api/x")] = (status, {})
            self.assertEqual(self.api.request("GET", "/api/x").unavailable, expect, status)
        self.login()
        self.siri.fail = httpx.ReadTimeout("slow")
        self.assertTrue(self.api.request("GET", "/api/x").unavailable)


class SwitchTests(ClientBase):
    def test_everything_is_off_without_a_session(self):
        self.assertEqual(self.api.switches(), {g: False for g in GROUPS})
        self.assertFalse(self.api.enabled("reads"))
        self.assertEqual(self.siri.calls, [])

    def test_a_group_is_on_only_when_the_server_says_true(self):
        self.login()
        self.siri.routes[("GET", "/api/store/config")] = switches_body(reads=True)
        self.assertTrue(self.api.enabled("reads"))
        self.assertFalse(self.api.enabled("bills_write"))
        self.assertFalse(self.api.enabled("not_a_group"))

    def test_the_answer_is_reused_until_it_gets_old_then_asked_again(self):
        self.login()
        self.siri.routes[("GET", "/api/store/config")] = switches_body(reads=True)
        self.api.enabled("reads")
        self.api.enabled("reads")
        self.api.enabled("returns")
        self.assertEqual(self.config_asks(), 1)
        self.now[0] += 125
        self.siri.routes[("GET", "/api/store/config")] = switches_body(reads=False)          # an admin turned it off
        self.assertFalse(self.api.enabled("reads"))
        self.assertEqual(self.config_asks(), 2)

    def test_if_the_server_cannot_be_asked_the_last_answer_is_kept_and_retries_are_spaced_out(self):
        self.login()
        self.siri.routes[("GET", "/api/store/config")] = switches_body(reads=True)
        self.assertTrue(self.api.enabled("reads"))
        self.now[0] += 125
        self.siri.fail = httpx.ConnectError("down")
        self.assertTrue(self.api.enabled("reads"))                                           # last known answer
        before = len(self.siri.calls)
        for _ in range(5):
            self.api.enabled("reads")
        self.assertEqual(len(self.siri.calls), before)                                       # not hammering siri-api
        self.now[0] += 40
        self.api.enabled("reads")
        self.assertGreater(len(self.siri.calls), before)

    def test_a_remembered_answer_is_used_after_a_restart_if_recent_but_not_if_a_day_old(self):
        self.login()
        self.siri.routes[("GET", "/api/store/config")] = switches_body(reads=True)
        self.assertTrue(self.api.enabled("reads"))
        self.siri.fail = httpx.ConnectError("down")
        recent = self.make()
        self.now[0] += 3600
        self.assertTrue(recent.enabled("reads"))
        old = self.make()
        self.now[0] += 25 * 3600
        self.assertFalse(old.enabled("reads"))

    def test_the_local_kill_switch_turns_everything_off_with_no_network_call(self):
        self.login()
        self.siri.routes[("GET", "/api/store/config")] = switches_body(reads=True)
        self.assertTrue(self.api.enabled("reads"))
        calls = len(self.siri.calls)
        os.environ["SIRI_API_DISABLE"] = "1"
        self.assertFalse(self.api.enabled("reads"))
        del os.environ["SIRI_API_DISABLE"]
        open(os.path.join(self.dir, "siri_disabled.flag"), "w").close()
        self.assertFalse(self.api.enabled("reads"))
        self.assertEqual(len(self.siri.calls), calls)

    def test_a_server_answer_with_junk_switches_means_off(self):
        self.login()
        self.siri.routes[("GET", "/api/store/config")] = (200, {"switches": {"reads": "true", "returns": 1}})
        self.assertEqual(self.api.switches(), {g: False for g in GROUPS})
        self.siri.routes[("GET", "/api/store/config")] = (200, {"nothing": 1})
        self.now[0] += 125
        self.assertEqual(self.api.switches(), {g: False for g in GROUPS})


# ---------------------------------------------------------------- the decorator

class ProxyTests(ClientBase):
    def setUp(self):
        super().setUp()
        siri_api._client = self.api                      # the decorator uses the shared client
        self.legacy_calls = []
        app = Flask(__name__)
        app.config["JWT_SECRET_KEY"] = "test-secret-that-is-long-enough-for-hmac-sha256"
        JWTManager(app)

        def legacy_products():
            self.legacy_calls.append("products")
            return jsonify({"from": "old path"})

        def legacy_product(product_id):
            self.legacy_calls.append(f"product {product_id}")
            return jsonify({"from": "old path", "id": product_id})

        def legacy_me():
            self.legacy_calls.append("me")
            return jsonify({"from": "old path"})

        app.add_url_rule("/api/products", "products", jwt_required()(via_siri_api("reads", "/api/store/products")(legacy_products)),
                         methods=["GET", "POST"])
        app.add_url_rule("/api/products/<product_id>", "product",
                         jwt_required()(via_siri_api("reads", "/api/store/products/{product_id}")(legacy_product)))
        app.add_url_rule("/api/stores/current", "current",
                         jwt_required()(via_siri_api("reads", "/api/store/me", transform=current_store_from_me)(legacy_me)))
        self.client = app.test_client()
        with app.app_context():
            self.headers = {"Authorization": "Bearer " + create_access_token(identity="cashier-1")}
            self.other = {"Authorization": "Bearer " + create_access_token(identity="cashier-2")}
        self.siri.routes[("GET", "/api/store/config")] = switches_body(reads=True)

    def tearDown(self):
        siri_api._client = None
        super().tearDown()

    def get(self, path, headers=None):
        return self.client.get(path, headers=headers or self.headers)

    def test_with_the_switch_off_the_old_path_answers_and_siri_api_is_never_called(self):
        self.login()
        self.siri.routes[("GET", "/api/store/config")] = switches_body(reads=False)
        r = self.get("/api/products")
        self.assertEqual(r.get_json(), {"from": "old path"})
        self.assertEqual([c for c in self.siri.calls if c.url.path.startswith("/api/store/products")], [])

    def test_without_a_siri_session_the_old_path_answers(self):
        r = self.get("/api/products")
        self.assertEqual(r.get_json(), {"from": "old path"})
        self.assertEqual(self.siri.calls, [])

    def test_with_the_switch_on_siri_api_answers_and_the_old_code_does_not_run(self):
        self.login()
        self.siri.routes[("GET", "/api/store/products")] = (200, [{"id": "p1"}], {"X-Partial": "0", "X-Data-Source": "cloud"})
        r = self.get("/api/products?search=ring&limit=5")
        self.assertEqual(r.get_json(), [{"id": "p1"}])
        self.assertEqual(r.headers["X-Siri-Api"], "1")
        self.assertEqual(r.headers["X-Partial"], "0")
        self.assertEqual(self.legacy_calls, [])
        sent = [c for c in self.siri.calls if c.url.path == "/api/store/products"][0]
        self.assertEqual(dict(sent.url.params), {"search": "ring", "limit": "5"})            # the screen's query is forwarded
        self.assertEqual(sent.headers["authorization"], "Bearer tok-1")

    def test_a_real_no_from_siri_api_is_returned_not_overridden_by_the_old_path(self):
        self.login()
        self.siri.routes[("GET", "/api/store/products/p9")] = (404, {"message": "Product not found"})
        r = self.get("/api/products/p9")
        self.assertEqual((r.status_code, r.get_json()), (404, {"message": "Product not found"}))
        self.siri.routes[("GET", "/api/store/products")] = (403, {"error": "That store is not assigned to this login"})
        self.assertEqual(self.get("/api/products").status_code, 403)
        self.assertEqual(self.legacy_calls, [])

    def test_siri_api_trouble_falls_back_to_the_old_path(self):
        self.login()
        for answer in ((500, {}), (502, {}), (503, {"retryable": True})):
            self.siri.routes[("GET", "/api/store/products")] = answer
            self.assertEqual(self.get("/api/products").get_json(), {"from": "old path"}, answer)
        self.siri.fail = httpx.ReadTimeout("slow")
        self.assertEqual(self.get("/api/products").get_json(), {"from": "old path"})
        self.assertEqual(len(self.legacy_calls), 4)

    def test_an_expired_siri_token_falls_back_and_stops_trying_until_the_next_login(self):
        self.login()
        self.siri.routes[("GET", "/api/store/products")] = (401, {"error": "expired"})
        self.assertEqual(self.get("/api/products").get_json(), {"from": "old path"})
        before = len(self.siri.calls)
        self.assertEqual(self.get("/api/products").get_json(), {"from": "old path"})
        self.assertEqual(len(self.siri.calls), before)                                       # no session any more: no call

    def test_a_different_cashier_than_the_one_siri_api_knows_uses_the_old_path(self):
        self.login()
        self.siri.routes[("GET", "/api/store/products")] = (200, [{"id": "p1"}])
        r = self.get("/api/products", headers=self.other)
        self.assertEqual(r.get_json(), {"from": "old path"})
        self.assertEqual([c for c in self.siri.calls if c.url.path == "/api/store/products"], [])

    def test_only_reads_are_ever_forwarded(self):
        self.login()
        self.siri.routes[("GET", "/api/store/products")] = (200, [{"id": "p1"}])
        r = self.client.post("/api/products", headers=self.headers, json={"x": 1})
        self.assertEqual(r.get_json(), {"from": "old path"})
        self.assertEqual([c for c in self.siri.calls if c.method == "POST" and c.url.path == "/api/store/products"], [])

    def test_the_kill_switch_sends_everything_the_old_way(self):
        self.login()
        self.siri.routes[("GET", "/api/store/products")] = (200, [{"id": "p1"}])
        os.environ["SIRI_API_DISABLE"] = "1"
        self.assertEqual(self.get("/api/products").get_json(), {"from": "old path"})

    def test_path_parts_are_quoted_so_an_id_cannot_add_a_query_or_change_the_route(self):
        self.login()
        self.siri.routes[("GET", "/api/store/products/a b?x=1#y")] = (200, {"id": "odd"})
        self.get("/api/products/a%20b%3Fx%3D1%23y")            # the id is: a b?x=1#y
        asked = [c for c in self.siri.calls if str(c.url.path).startswith("/api/store/products/")]
        self.assertEqual(len(asked), 1)
        self.assertEqual(asked[0].url.path, "/api/store/products/a b?x=1#y")     # one path segment, taken literally...
        self.assertEqual(asked[0].url.query, b"")                                # ...no query string was smuggled in

    def test_the_transform_turns_me_into_the_old_stores_current_shape(self):
        self.login()
        self.siri.routes[("GET", "/api/store/me")] = (200, {"user": {"id": "cashier-1"}, "store": {"id": "s1", "name": "Kurnool"}})
        self.assertEqual(self.get("/api/stores/current").get_json(), {"id": "s1", "name": "Kurnool"})
        self.siri.routes[("GET", "/api/store/me")] = (200, {"user": {"id": "cashier-1"}, "store": None})
        r = self.get("/api/stores/current")
        self.assertEqual(r.status_code, 404)
        self.assertEqual(self.legacy_calls, [])

    def test_a_transform_that_cannot_make_sense_of_the_answer_gives_a_clean_404_not_a_crash(self):
        self.login()
        self.siri.routes[("GET", "/api/store/me")] = (200, ["a list"])
        self.assertEqual(self.get("/api/stores/current").status_code, 404)


if __name__ == "__main__":
    unittest.main()
