/**
 * The store app's update rule (pure functions, easy to test; the timers and screens live in components/Updater.tsx).
 *
 *   The FIRST time the app is opened each day, a new version (if there is one) is downloaded and installed by itself,
 *   with a "please wait" screen. After that nothing is installed or shown until someone presses "Check for updates".
 *   An update that is found by hand is installed only when the person clicks "Install Now".
 */
export const RETRY_AFTER_CHECK_FAILURE_MS = 5 * 60_000
export const RETRY_AFTER_INSTALL_FAILURE_MS = 30 * 60_000

/** Today's date on this PC, e.g. "2026-11-14" (the day boundary is the shop's own midnight). */
export function localDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export interface MorningCheck {
  today: string
  lastDoneDay: string | null // the day the automatic check last completed
  busy: boolean // a bill, invoice edit or replacement is open
  running: boolean // a check or install is already under way
  now: number
  retryNotBefore: number
}

/** Should the once-a-day automatic update run right now? */
export function shouldRunMorningUpdate(c: MorningCheck): boolean {
  if (c.running || c.busy) return false
  if (c.now < c.retryNotBefore) return false
  return c.lastDoneDay !== c.today
}
