export const EDIT_WINDOW_HOURS = 24
export const EDITABLE_STATUSES = ["completed", "paid", "pending"] as const

const toIsoLike = (value: string | Date | undefined | null): Date | null => {
  if (!value) return null
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }

  const raw = String(value).trim()
  if (!raw) return null

  const hasExplicitTimezone = /([zZ]|[+-]\d{2}:\d{2})$/.test(raw)
  const normalized = !hasExplicitTimezone && raw.includes("T") ? `${raw}+05:30` : raw
  const parsed = new Date(normalized)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export const getInvoiceEditExpiresAtMs = (invoice: {
  createdAt?: string | Date | null
  timestamp?: string | Date | null
  editExpiresAt?: string | Date | null
}): number => {
  const explicitExpiry = toIsoLike(invoice.editExpiresAt)
  if (explicitExpiry) return explicitExpiry.getTime()

  const fallbackCreated = toIsoLike(invoice.timestamp || invoice.createdAt)
  if (!fallbackCreated) return 0

  return fallbackCreated.getTime() + EDIT_WINDOW_HOURS * 60 * 60 * 1000
}

export const getInvoiceEditSecondsRemaining = (
  invoice: {
    createdAt?: string | Date | null
    timestamp?: string | Date | null
    editExpiresAt?: string | Date | null
    secondsRemaining?: number | null
  },
  nowMs: number,
): number => {
  const expiresAtMs = getInvoiceEditExpiresAtMs(invoice)
  if (expiresAtMs > 0) {
    return Math.max(0, Math.floor((expiresAtMs - nowMs) / 1000))
  }

  if (typeof invoice.secondsRemaining === "number" && invoice.secondsRemaining >= 0) {
    return invoice.secondsRemaining
  }

  return 0
}

export const canEditInvoice = (
  invoice: {
    status?: string | null
    createdAt?: string | Date | null
    timestamp?: string | Date | null
    editExpiresAt?: string | Date | null
    canEdit?: boolean | null
  },
  nowMs: number,
): boolean => {
  const status = String(invoice.status || "").toLowerCase()
  const isEligibleStatus = EDITABLE_STATUSES.includes(status as (typeof EDITABLE_STATUSES)[number])

  if (!isEligibleStatus) return false

  const expiresAtMs = getInvoiceEditExpiresAtMs(invoice)
  if (expiresAtMs <= 0) return false

  return nowMs <= expiresAtMs
}
