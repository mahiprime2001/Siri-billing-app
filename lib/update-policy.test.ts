import test from "node:test"
import assert from "node:assert/strict"
import {
  localDay,
  parsePolicy,
  passiveBannerAllowed,
  shouldRunMorningUpdate,
  type MorningCheck,
} from "./update-policy.ts"

const auto = { auto: true, hold: false }
const base: MorningCheck = {
  policy: auto,
  today: "2026-11-14",
  lastDoneDay: "2026-11-13",
  busy: false,
  running: false,
  now: 1_000_000,
  retryNotBefore: 0,
}

test("policy: only auto_update=true with a signed-in store installs by itself", () => {
  assert.deepEqual(parsePolicy({ auto_update: true, update_hold: false, ready: true }), { auto: true, hold: false })
  assert.equal(parsePolicy({ auto_update: true, ready: false }).auto, false)            // switches not known yet
  assert.equal(parsePolicy({ auto_update: true }).auto, false)
  for (const junk of [null, undefined, "yes", 1, [], {}, { auto_update: "true", ready: true }, { auto_update: 1, ready: true }]) {
    assert.equal(parsePolicy(junk).auto, false, JSON.stringify(junk))
  }
})

test("policy: a hold beats auto_update and is reported", () => {
  assert.deepEqual(parsePolicy({ auto_update: true, update_hold: true, ready: true }), { auto: false, hold: true })
  assert.deepEqual(parsePolicy({ update_hold: true }), { auto: false, hold: true })
})

test("the first time the app is opened on a new day, the automatic update runs", () => {
  assert.equal(shouldRunMorningUpdate(base), true)
  assert.equal(shouldRunMorningUpdate({ ...base, lastDoneDay: null }), true)
})

test("once it has run today it does not run again until tomorrow", () => {
  assert.equal(shouldRunMorningUpdate({ ...base, lastDoneDay: "2026-11-14" }), false)
  assert.equal(shouldRunMorningUpdate({ ...base, lastDoneDay: "2026-11-14", today: "2026-11-15" }), true)
})

test("it never runs without the auto switch, or under a hold", () => {
  assert.equal(shouldRunMorningUpdate({ ...base, policy: { auto: false, hold: false } }), false)
  assert.equal(shouldRunMorningUpdate({ ...base, policy: { auto: true, hold: true } }), false)
})

test("it waits while a bill is open or another check is running, and after a failure", () => {
  assert.equal(shouldRunMorningUpdate({ ...base, busy: true }), false)
  assert.equal(shouldRunMorningUpdate({ ...base, running: true }), false)
  assert.equal(shouldRunMorningUpdate({ ...base, retryNotBefore: base.now + 1 }), false)
  assert.equal(shouldRunMorningUpdate({ ...base, retryNotBefore: base.now }), true)
})

test("the old pop-up banner is used only when the automatic rule is not", () => {
  assert.equal(passiveBannerAllowed({ auto: false, hold: false }), true)    // default stores: unchanged
  assert.equal(passiveBannerAllowed({ auto: true, hold: false }), false)    // auto stores: only the morning update / manual check
  assert.equal(passiveBannerAllowed({ auto: false, hold: true }), false)    // paused
})

test("the day is the shop's own local date", () => {
  assert.equal(localDay(new Date(2026, 10, 14, 0, 5)), "2026-11-14")
  assert.equal(localDay(new Date(2026, 10, 14, 23, 59)), "2026-11-14")
  assert.equal(localDay(new Date(2026, 0, 3, 9, 0)), "2026-01-03")
})
