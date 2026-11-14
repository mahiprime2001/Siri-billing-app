/**
 * A tiny shared "I am in the middle of something" flag, so the auto-updater never restarts the app under a cashier.
 * Screens call setUpdateBusy("name", true) while work is open and setUpdateBusy("name", false) when it is done;
 * the updater asks isUpdateBusy() before it starts anything.
 */
const holders = new Set<string>()

export function setUpdateBusy(key: string, busy: boolean): void {
  if (busy) holders.add(key)
  else holders.delete(key)
}

export function isUpdateBusy(): boolean {
  return holders.size > 0
}
