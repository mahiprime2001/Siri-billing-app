/**
 * The store app's update rule (pure functions, easy to test; the timers and screens live in components/Updater.tsx).
 *
 *   auto_update OFF (default)  the old behaviour: a banner whenever a new version exists, "Install Now" / "Later".
 *   auto_update ON             ONE automatic update per day: the first time the app is opened that day, a new version
 *                              (if any) is downloaded and installed by itself, with a "please wait" screen. After
 *                              that nothing is installed or shown until someone presses "Check for updates".
 *   update_hold ON             the owner's pause button: nothing is installed, by itself or by hand.
 *
 * These come from siri-api's switches through the local backend (/api/update-policy), per store.
 */
export const RETRY_AFTER_CHECK_FAILURE_MS = 5 * 60_000
export const RETRY_AFTER_INSTALL_FAILURE_MS = 30 * 60_000

export interface UpdatePolicy {
  auto: boolean // the once-a-day automatic update applies
  hold: boolean // install nothing
}

/**
 * What the local backend answered. Anything unclear means the old behaviour (ask the user), never an install.
 * `ready` is false until a cashier is signed in to siri-api, because only then are the store's switches known.
 */
export function parsePolicy(raw: unknown): UpdatePolicy {
  if (!raw || typeof raw !== "object") return { auto: false, hold: false }
  const r = raw as Record<string, unknown>
  const hold = r.update_hold === true
  return { auto: r.auto_update === true && r.ready === true && !hold, hold }
}

/** Today's date on this PC, e.g. "2026-11-14" (the day boundary is the shop's own midnight). */
export function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export interface MorningCheck {
  policy: UpdatePolicy
  today: string
  lastDoneDay: string | null // the day the automatic check last completed
  busy: boolean // a bill, invoice edit or replacement is open
  running: boolean // a check or install is already under way
  now: number
  retryNotBefore: number
}

/** Should the once-a-day automatic update run right now? */
export function shouldRunMorningUpdate(c: MorningCheck): boolean {
  if (!c.policy.auto || c.policy.hold) return false
  if (c.running || c.busy) return false
  if (c.now < c.retryNotBefore) return false
  return c.lastDoneDay !== c.today
}

/** The old passive banner / periodic checks apply only when the automatic rule does not. */
export function passiveBannerAllowed(policy: UpdatePolicy): boolean {
  return !policy.hold && !policy.auto
}
