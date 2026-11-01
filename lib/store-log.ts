// lib/store-log.ts
// Writes events into the store's .log files (Rust side, src-tauri/src/store_log.rs),
// which are shipped to the VPS. Everything here is best-effort: logging must never
// break billing, so every call swallows its own errors. Outside the Tauri app
// (browser dev) these are no-ops.
//
// Log ids, counts and error text only -- never passwords, tokens or customer details.
import { invoke } from "@tauri-apps/api/core"
import { apiClient } from "./api-client"

type Level = "info" | "warn" | "error"

// Baked in at build time from the CLIENT_LOG_KEY GitHub secret (see release.yml).
// Without it logs are still written locally, they just aren't uploaded.
const LOG_KEY = process.env.NEXT_PUBLIC_CLIENT_LOG_KEY || ""
const LOG_API = process.env.NEXT_PUBLIC_LOG_API_URL || "https://api.ifleon.com"

const inTauri = (): boolean => typeof window !== "undefined" && Boolean((window as any).__TAURI__)

export function logEvent(level: Level, category: string, message: string): void {
  if (!inTauri()) return
  invoke("write_store_log", { level, category, message }).catch(() => {})
}

/**
 * Shadow mode for the Rust offline database: tells Rust which barcode was scanned and which
 * product the current (Flask) lookup found, so Rust can look it up too and log whether they
 * agree. Never affects billing; failures are ignored.
 */
export function shadowBarcode(barcode: string, flaskProductId: string | null | undefined): void {
  if (!inTauri()) return
  invoke("shadow_barcode_check", { barcode, flaskProductId: flaskProductId ?? null }).catch(() => {})
}

let contextKey = ""

/** Tells the Rust side which store this is, and enables uploads. Safe to call repeatedly. */
export async function initStoreLog(): Promise<void> {
  if (!inTauri()) return
  try {
    const res = await apiClient("/api/stores/current")
    if (!res.ok) return
    const store = await res.json()
    const storeId = String(store?.id ?? "")
    if (!storeId || storeId === contextKey) return
    await invoke("set_log_context", {
      apiBase: LOG_API,
      logKey: LOG_KEY,
      storeId,
      storeName: String(store?.name ?? ""),
    })
    contextKey = storeId
  } catch {
    // offline or not signed in yet -- will be retried on the next call
  }
}
