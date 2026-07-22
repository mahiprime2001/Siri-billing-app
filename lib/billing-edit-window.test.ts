import test from "node:test"
import assert from "node:assert/strict"
import { canEditInvoice, getInvoiceEditSecondsRemaining } from "./billing-edit-window.js"

test("allows edit when backend says false but the local 24h window is still open", () => {
  const invoice = {
    id: "bill-1",
    status: "completed",
    createdAt: "2026-07-19T10:00:00.000Z",
    canEdit: false,
  }

  assert.equal(canEditInvoice(invoice, new Date("2026-07-19T20:00:00.000Z").getTime()), true)
})

test("blocks edit once the local 24h window has expired", () => {
  const invoice = {
    id: "bill-2",
    status: "pending",
    createdAt: "2026-07-18T10:00:00.000Z",
    canEdit: true,
  }

  assert.equal(canEditInvoice(invoice, new Date("2026-07-19T10:01:00.000Z").getTime()), false)
})

test("blocks edit for non-editable statuses", () => {
  const invoice = {
    id: "bill-3",
    status: "cancelled",
    createdAt: "2026-07-19T10:00:00.000Z",
  }

  assert.equal(canEditInvoice(invoice, new Date("2026-07-19T12:00:00.000Z").getTime()), false)
})

test("calculates remaining edit time from createdAt when editExpiresAt is missing", () => {
  const invoice = {
    id: "bill-4",
    status: "completed",
    createdAt: "2026-07-19T12:18:41",
  }

  assert.equal(
    getInvoiceEditSecondsRemaining(invoice, new Date("2026-07-19T13:18:41+05:30").getTime()),
    23 * 60 * 60,
  )
  assert.equal(canEditInvoice(invoice, new Date("2026-07-19T13:18:41+05:30").getTime()), true)
})

test("prefers the visible invoice timestamp over createdAt for the edit window", () => {
  const invoice = {
    id: "bill-5",
    status: "completed",
    timestamp: "2026-07-19T12:18:41",
    createdAt: "2026-07-17T12:18:41",
  }

  assert.equal(
    getInvoiceEditSecondsRemaining(invoice, new Date("2026-07-19T13:18:41+05:30").getTime()),
    23 * 60 * 60,
  )
  assert.equal(canEditInvoice(invoice, new Date("2026-07-19T13:18:41+05:30").getTime()), true)
})
