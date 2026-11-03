"""
Billing pause (an admin paused this store's billing for an audit): the backend must refuse new
bills while the Tauri shell's flag file says paused, must never refuse because of a problem with
that file, and must never touch bills that are already made.

Run from the backend folder:   .venv\\Scripts\\python.exe -m unittest tests.test_billing_pause -v
"""
import json
import os
import sys
import tempfile
import time
import unittest
from unittest import mock

BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BACKEND not in sys.path:
    sys.path.insert(0, BACKEND)

from flask import Flask  # noqa: E402

import routes.billing_routes as billing  # noqa: E402
from utils import billing_pause  # noqa: E402


class FlagFileTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="billing-pause-test-")
        self.path = os.path.join(self.dir, "billing-pause.json")

    def write(self, **fields):
        body = {"paused": True, "message": "An audit is in progress", "since": "2026-11-03T06:00:00+00:00",
                "checkedAtEpoch": time.time(), **fields}
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(body, f)

    def test_a_fresh_paused_file_pauses(self):
        self.write()
        got = billing_pause.current_pause(self.path)
        self.assertEqual(got, {"message": "An audit is in progress", "since": "2026-11-03T06:00:00+00:00"})

    def test_not_paused_means_not_paused(self):
        self.write(paused=False)
        self.assertIsNone(billing_pause.current_pause(self.path))

    def test_only_a_real_true_pauses(self):
        for junk in ("true", 1, "yes", None, [], {}):
            self.write(paused=junk)
            self.assertIsNone(billing_pause.current_pause(self.path), junk)

    def test_an_old_answer_is_not_believed(self):
        """A PC that lost internet while paused must not stay frozen."""
        now = time.time()
        self.write(checkedAtEpoch=now - billing_pause.MAX_AGE_SECONDS + 5)
        self.assertIsNotNone(billing_pause.current_pause(self.path, now=now))
        self.write(checkedAtEpoch=now - billing_pause.MAX_AGE_SECONDS - 5)
        self.assertIsNone(billing_pause.current_pause(self.path, now=now))

    def test_every_kind_of_trouble_fails_open(self):
        self.assertIsNone(billing_pause.current_pause(os.path.join(self.dir, "missing.json")))   # no file
        for content in ("", "not json", "[]", "null", "{", '{"paused": true}'):                  # last: never checked
            with open(self.path, "w", encoding="utf-8") as f:
                f.write(content)
            self.assertIsNone(billing_pause.current_pause(self.path), repr(content))
        self.write(checkedAtEpoch="soon")
        self.assertIsNone(billing_pause.current_pause(self.path))
        self.assertIsNone(billing_pause.current_pause(self.dir))                                 # a folder, not a file

    def test_defaults_when_the_message_is_missing(self):
        self.write(message=None, since=None)
        got = billing_pause.current_pause(self.path)
        self.assertTrue(got["message"])
        self.assertIsNone(got["since"])

    def test_the_file_location_can_be_set_by_environment(self):
        self.write()
        with mock.patch.dict(os.environ, {"BILLING_PAUSE_FILE": self.path}):
            self.assertIsNotNone(billing_pause.current_pause())
        with mock.patch.dict(os.environ, {"BILLING_PAUSE_FILE": os.path.join(self.dir, "nope.json")}):
            self.assertIsNone(billing_pause.current_pause())


class CreateBillTests(unittest.TestCase):
    """The real create_bill route code (login decorator bypassed), with the billing step faked
    so a bill that should be refused provably never reaches it."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="billing-pause-test-")
        self.path = os.path.join(self.dir, "billing-pause.json")
        self.app = Flask(__name__)
        self.create = billing.create_bill.__wrapped__          # undo @require_auth only
        patches = [
            mock.patch.dict(os.environ, {"BILLING_PAUSE_FILE": self.path}),
            mock.patch.object(billing, "get_jwt_identity", return_value="u1"),
            mock.patch.object(billing, "_lookup_bill_by_request_id", return_value=None),
            mock.patch.object(billing, "_remember_bill_request"),
            mock.patch.object(billing, "dispatch_bill_create",
                              return_value={"queued": False, "bill_id": "INV-1"}),
        ]
        self.mocks = [p.start() for p in patches]
        self.dispatch = self.mocks[-1]
        self.addCleanup(mock.patch.stopall)

    def pause(self, **over):
        body = {"paused": True, "message": "An audit is in progress", "since": "2026-11-03T06:00:00+00:00",
                "checkedAtEpoch": time.time(), **over}
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(body, f)

    def post(self, body=None):
        with self.app.test_request_context("/bills", method="POST", json=body or {"items": []}):
            result = self.create()
        response, status = result if isinstance(result, tuple) else (result, result.status_code)
        return response.get_json(), status

    def test_a_paused_store_cannot_make_a_new_bill(self):
        self.pause()
        body, status = self.post()
        self.assertEqual(status, 423)
        self.assertEqual(body["error"], "billing_paused")
        self.assertEqual(body["message"], "An audit is in progress")
        self.assertEqual(body["since"], "2026-11-03T06:00:00+00:00")
        self.dispatch.assert_not_called()                      # nothing was created

    def test_not_paused_billing_works_as_before(self):
        self.pause(paused=False)
        body, status = self.post()
        self.assertEqual(status, 201)
        self.assertEqual(body["bill_id"], "INV-1")
        self.dispatch.assert_called_once()

    def test_no_pause_file_at_all_billing_works(self):
        body, status = self.post()
        self.assertEqual(status, 201)

    def test_a_stale_pause_does_not_block(self):
        self.pause(checkedAtEpoch=time.time() - billing_pause.MAX_AGE_SECONDS - 60)
        _, status = self.post()
        self.assertEqual(status, 201)
        self.dispatch.assert_called_once()

    def test_a_broken_pause_file_does_not_block(self):
        with open(self.path, "w", encoding="utf-8") as f:
            f.write("{ broken")
        _, status = self.post()
        self.assertEqual(status, 201)

    def test_resuming_lets_the_very_next_bill_through(self):
        self.pause()
        self.assertEqual(self.post()[1], 423)
        self.pause(paused=False)
        self.assertEqual(self.post()[1], 201)

    def test_a_replayed_bill_that_was_already_processed_is_not_blocked(self):
        """A retry of a bill that already exists must return it, pause or not."""
        self.pause()
        existing = {"id": "INV-OLD"}
        with mock.patch.object(billing, "_lookup_bill_by_request_id", return_value="INV-OLD"), \
             mock.patch.object(billing, "get_supabase_client", return_value=object()), \
             mock.patch.object(billing, "_fetch_bill_by_id", return_value=existing), \
             mock.patch.object(billing, "_bill_has_items", return_value=True):
            body, status = self.post({"_client_request_id": "abc", "items": []})
        self.assertEqual(status, 200)
        self.assertEqual(body["bill_id"], "INV-OLD")
        self.assertTrue(body["idempotent_replay"])
        self.dispatch.assert_not_called()


if __name__ == "__main__":
    unittest.main()
