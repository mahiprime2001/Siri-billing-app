/**
 * The store app's update rule (pure functions, easy to test; the timers and screens live in components/Updater.tsx).
 *
 *   The FIRST time the app is opened each day, a new version (if there is one) is downloaded and installed by itself,
 *   with a "please wait" screen. After that nothing is installed by itself: the app looks every 30 minutes and, when
 *   a newer version exists, shows the blue "Update Available" box (Install Now / Later). "Check for updates" asks
 *   at once. An update found after the morning one is installed only when the person clicks "Install Now".
 */
export const RETRY_AFTER_CHECK_FAILURE_MS = 5 * 60_000
export const RETRY_AFTER_INSTALL_FAILURE_MS = 30 * 60_000
/** After the morning update, how often the app quietly looks for a newer version to offer. */
export const ANNOUNCE_EVERY_MS = 30 * 60_000
/** "Later" on the Update box hides that version's box for this long. */
export const MUTE_AFTER_LATER_MS = 4 * 60 * 60_000

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

export interface AnnounceCheck {
  today: string
  lastDoneDay: string | null // the day the automatic (morning) check last completed
  running: boolean // a check or install is already under way
  now: number
  nextAnnounceAt: number // not before this moment
}

/** Should the app quietly look for a newer version to OFFER (blue box, never installed by itself) right now? */
export function shouldAnnounceUpdate(c: AnnounceCheck): boolean {
  if (c.running) return false
  if (c.lastDoneDay !== c.today) return false // the morning check goes first and handles the new day
  return c.now >= c.nextAnnounceAt
}
