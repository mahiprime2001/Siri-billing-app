// "Pause billing at this store while an audit runs" -- screen side.
// The Rust shell asks siri-api every ~30 s and exposes the answer as the `get_billing_pause`
// command (src-tauri/src/billing_pause.rs). Pure helpers here so they can be checked on their own.

export interface BillingPause {
  paused: boolean
  message: string
  since: string | null
}

export const NOT_PAUSED: BillingPause = { paused: false, message: "", since: null }

/** Anything that isn't clearly `{ paused: true }` means "not paused" -- a glitch must never lock the till. */
export function parseBillingPause(raw: unknown): BillingPause {
  if (!raw || typeof raw !== "object") return NOT_PAUSED
  const o = raw as Record<string, unknown>
  if (o.paused !== true) return NOT_PAUSED
  return {
    paused: true,
    message: typeof o.message === "string" ? o.message : "",
    since: typeof o.since === "string" && o.since ? o.since : null,
  }
}

/** "11:40 AM" in the PC's own time, or "" if the time can't be read. */
export function formatSince(iso: string | null | undefined): string {
  if (!iso) return ""
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

export const DEFAULT_MESSAGE = "An audit is in progress at this store. Billing is paused until it is finished."
