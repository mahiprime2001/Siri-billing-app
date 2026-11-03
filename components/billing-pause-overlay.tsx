"use client"

import { useEffect, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { DEFAULT_MESSAGE, NOT_PAUSED, formatSince, parseBillingPause, type BillingPause } from "@/lib/billing-pause"

const POLL_MS = 4000

const inTauri = (): boolean => typeof window !== "undefined" && Boolean((window as any).__TAURI__)

/**
 * Full-screen "Billing is paused" dialog, shown while the admin has paused this store for an audit.
 *
 * Nothing behind it can be used: every other part of the page is made `inert`, which also stops
 * keyboard focus and barcode-scanner typing from reaching the billing screen. It has no close
 * button -- it clears by itself within seconds of the admin finishing (or cancelling) the audit.
 * The store's backend ALSO refuses new bills while paused, so this is not the only guard.
 */
export default function BillingPauseOverlay() {
  const [state, setState] = useState<BillingPause>(NOT_PAUSED)
  const root = useRef<HTMLDivElement>(null)

  // Ask the shell (it caches siri-api's answer); a local call, so a short interval is cheap.
  useEffect(() => {
    if (!inTauri()) return
    let alive = true
    const read = async () => {
      try {
        const next = parseBillingPause(await invoke("get_billing_pause"))
        if (alive) setState((prev) => (prev.paused === next.paused && prev.since === next.since && prev.message === next.message ? prev : next))
      } catch {
        // can't ask: leave whatever is showing
      }
    }
    void read()
    const timer = setInterval(() => void read(), POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  // While paused, make everything else on the page unusable (clicks, Tab, typed/scanned keys).
  useEffect(() => {
    if (!state.paused) return
    const marked = new Set<Element>()
    const lock = () => {
      for (const el of Array.from(document.body.children)) {
        // Never lock the dialog itself, nor anything that contains it (it would lock it too).
        if (el === root.current || el.contains(root.current) || el.hasAttribute("inert")) continue
        el.setAttribute("inert", "")
        marked.add(el)
      }
    }
    lock()
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    // Things added to the page later (a toast, a dialog) are locked too.
    const watcher = new MutationObserver(lock)
    watcher.observe(document.body, { childList: true })
    return () => {
      watcher.disconnect()
      marked.forEach((el) => el.removeAttribute("inert"))
    }
  }, [state.paused])

  if (!state.paused) return null

  const since = formatSince(state.since)
  return (
    <div
      ref={root}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="billing-paused-title"
      className="fixed inset-0 z-[2147483647] flex items-center justify-center bg-slate-900/95 p-6"
    >
      <div className="w-full max-w-lg rounded-2xl bg-white p-8 text-center shadow-2xl">
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-amber-100 text-3xl" aria-hidden>
          ⏸
        </div>
        <h1 id="billing-paused-title" className="text-2xl font-bold text-slate-900">
          Billing is paused
        </h1>
        <p className="mt-3 text-base text-slate-700">{state.message || DEFAULT_MESSAGE}</p>
        {since && <p className="mt-2 text-sm text-slate-500">Paused since {since}</p>}
        <p className="mt-6 text-sm text-slate-600">
          Please wait. Billing starts again by itself when the audit is finished — you don&apos;t need to do anything.
        </p>
        <div className="mt-6 flex items-center justify-center gap-2 text-xs text-slate-400">
          <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" aria-hidden />
          Checking again automatically
        </div>
      </div>
    </div>
  )
}
