import test from "node:test"
import assert from "node:assert/strict"
import { localDay, shouldRunMorningUpdate, type MorningCheck } from "./update-policy.ts"

const base: MorningCheck = {
  today: "2026-11-14",
  lastDoneDay: "2026-11-13",
  busy: false,
  running: false,
  now: 1_000_000,
  retryNotBefore: 0,
}

test("the first time the app is opened on a new day, the automatic update runs", () => {
  assert.equal(shouldRunMorningUpdate(base), true)
  assert.equal(shouldRunMorningUpdate({ ...base, lastDoneDay: null }), true)
})

test("once it has run today it does not run again until tomorrow", () => {
  assert.equal(shouldRunMorningUpdate({ ...base, lastDoneDay: "2026-11-14" }), false)
  assert.equal(shouldRunMorningUpdate({ ...base, lastDoneDay: "2026-11-14", today: "2026-11-15" }), true)
})

test("it waits while a bill is open or another check is running", () => {
  assert.equal(shouldRunMorningUpdate({ ...base, busy: true }), false)
  assert.equal(shouldRunMorningUpdate({ ...base, running: true }), false)
})

test("after a failure it waits before trying again, then tries", () => {
  assert.equal(shouldRunMorningUpdate({ ...base, retryNotBefore: base.now + 1 }), false)
  assert.equal(shouldRunMorningUpdate({ ...base, retryNotBefore: base.now }), true)
})

test("the day is the shop's own local date", () => {
  assert.equal(localDay(new Date(2026, 10, 14, 0, 5)), "2026-11-14")
  assert.equal(localDay(new Date(2026, 10, 14, 23, 59)), "2026-11-14")
  assert.equal(localDay(new Date(2026, 0, 3, 9, 0)), "2026-01-03")
})
