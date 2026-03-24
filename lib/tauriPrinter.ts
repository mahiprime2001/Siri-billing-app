// lib/tauriPrinter.ts
// ✅ Uses native Tauri commands (print_html_native / list_printers_native)
// ✅ No wkhtmltopdf, no PDF conversion, no plugin dependency
// ✅ Supports N copies directly, preserves your HTML design

import { invoke } from "@tauri-apps/api/core";

export const isTauriApp = (): boolean => {
  return typeof window !== "undefined" && Boolean((window as any).__TAURI__);
};

const isPrinterDebugEnabled = (): boolean => {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem("printerDebug") === "true";
  } catch {
    return false;
  }
};

const shouldDebug = (forceDebug?: boolean): boolean =>
  typeof forceDebug === "boolean" ? forceDebug : isPrinterDebugEnabled();

const debugLog = (forceDebug: boolean | undefined, ...args: unknown[]) => {
  if (shouldDebug(forceDebug)) {
    console.debug("🖨️ [tauriPrinter]", ...args);
  }
};

// ── List available printers ────────────────────────────────────────────────

export async function listPrinters(): Promise<string[]> {
  if (!isTauriApp()) return [];
  try {
    debugLog(undefined, "Listing printers via native command...");
    const printers = await invoke<string[]>("list_printers_native");
    debugLog(undefined, "Printers:", printers);
    return printers;
  } catch (error) {
    console.error("❌ [tauriPrinter] Failed to list printers:", error);
    return [];
  }
}

// ── Types ──────────────────────────────────────────────────────────────────

type HtmlPrintOptions = {
  printerName?: string;
  paperSize?: string;
  // FIX Risk 2: copies is now explicitly required at call sites.
  // If not passed, it safely defaults to 1 (not 2) inside the function.
  copies?: number;
  debug?: boolean;
};

// FIX Risk 4: printInProgress is now guarded by a timestamp-based stale lock.
// If the lock has been held for >30 seconds (e.g. app navigated away mid-print,
// or a crash prevented finally() from running), it auto-resets.
let printInProgress = false;
let printLockTimestamp = 0;
const PRINT_LOCK_TIMEOUT_MS = 30_000;

function acquirePrintLock(): boolean {
  const now = Date.now();
  if (printInProgress && now - printLockTimestamp > PRINT_LOCK_TIMEOUT_MS) {
    console.warn("⚠️ [tauriPrinter] Print lock was stale (>30s), force-resetting.");
    printInProgress = false;
  }
  if (printInProgress) return false;
  printInProgress = true;
  printLockTimestamp = now;
  return true;
}

function releasePrintLock(): void {
  printInProgress = false;
  printLockTimestamp = 0;
}

// ── Build a complete, self-contained HTML document for printing ────────────

function buildPrintHtml(htmlContent: string, paperSize?: string): string {
  let pageWidth = "210mm";
  let pageHeight = "auto";
  let thermalContainerWidth = "";
  let thermalContainerMargin = "0 auto";

  if (paperSize === "Thermal 80mm") {
    pageWidth = "80mm";
    thermalContainerWidth = "70mm";
    thermalContainerMargin = "0";
  } else if (paperSize === "Thermal 58mm") {
    pageWidth = "58mm";
    thermalContainerWidth = "48mm";
    thermalContainerMargin = "0";
  } else if (paperSize === "A4") {
    pageWidth = "210mm";
    pageHeight = "297mm";
  } else if (paperSize === "Letter") {
    pageWidth = "216mm";
    pageHeight = "279mm";
  }

  const pageStyle = `
<style data-siri-print-style="true">
  @page {
    size: ${pageWidth} ${pageHeight};
    margin: 0;
  }
  @media print {
    html, body {
      margin: 0 !important;
      padding: 0 !important;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    .no-print { display: none !important; }
  }
  ${thermalContainerWidth ? `
  body {
    width: ${pageWidth} !important;
    margin: 0 !important;
    padding: 0 !important;
  }
  .print-container {
    width: ${thermalContainerWidth} !important;
    margin: ${thermalContainerMargin} !important;
    padding: 0 !important;
    box-sizing: border-box !important;
  }` : ""}
</style>`;

  if (/<\/head>/i.test(htmlContent)) {
    return htmlContent.replace(/<\/head>/i, `${pageStyle}\n</head>`);
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  ${pageStyle}
</head>
<body>
  ${htmlContent}
</body>
</html>`;
}

// ── MAIN FUNCTION: Print HTML directly to printer with N copies ────────────
//
// Calls the Rust `print_html_native` command which:
//   1. Writes HTML to a temp file
//   2. Loads it in a hidden WebView2 window
//   3. Calls ICoreWebView2_16::Print() with exact printer + copies
//   4. No dialog, no PDF, no extra tools required
//
export async function printHtmlContent(
  html: string,
  options?: HtmlPrintOptions
): Promise<string> {
  if (!isTauriApp()) {
    throw new Error("HTML printing is only available in the desktop app.");
  }

  // FIX Risk 4: stale-safe lock
  if (!acquirePrintLock()) {
    const msg = "Print already in progress. Skipping duplicate call.";
    debugLog(options?.debug, msg);
    return msg;
  }

  const printerName = options?.printerName ?? "";

  // FIX Risk 2: default is now 1, not 2.
  const copies = Math.max(
    1,
    Number.isFinite(options?.copies) ? Number(options?.copies) : 1
  );

  debugLog(options?.debug, "Invoking print_html_native...", {
    printer: printerName || "SYSTEM_DEFAULT",
    copies,
    paperSize: options?.paperSize,
    htmlLength: html.length,
  });

  const printReadyHtml = buildPrintHtml(html, options?.paperSize);

  try {
    // Pass paperSize for logging and future print settings alignment.
    const result = await invoke<string>("print_html_native", {
      html: printReadyHtml,
      printerName,
      copies,
      paperSize: options?.paperSize ?? "Thermal 80mm",
    });

    debugLog(options?.debug, "Print result:", result);
    console.info("[tauriPrinter] printHtmlContent result:", result);
    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("❌ [tauriPrinter] printHtmlContent failed:", msg);
    throw new Error(msg);
  } finally {
    releasePrintLock();
  }
}

// ── Text/receipt printing ──────────────────────────────────────────────────

type SilentPrintOptions = {
  printerName?: string;
  paperSize?: string;
  copies?: number;
  debug?: boolean;
};

export async function silentPrintText(
  content: string,
  options?: SilentPrintOptions
): Promise<string> {
  if (!isTauriApp()) {
    throw new Error("Silent printing is only available in the desktop app.");
  }

  // FIX Risk 4: stale-safe lock
  if (!acquirePrintLock()) {
    const msg = "Print already in progress. Skipping duplicate call.";
    debugLog(options?.debug, msg);
    return msg;
  }

  const printerName = options?.printerName ?? "";

  // FIX Risk 2: default is now 1, not 2.
  const copies = Math.max(
    1,
    Number.isFinite(options?.copies) ? Number(options?.copies) : 1
  );

  let paperWidthMm: number | undefined;
  if (options?.paperSize === "Thermal 58mm") paperWidthMm = 58;
  else if (options?.paperSize === "Thermal 80mm") paperWidthMm = 80;

  const widthStyle = paperWidthMm ? ` width: ${paperWidthMm}mm;` : "";
  const escapedContent = content
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const receiptHtml = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/>
<style>
  * { margin:0; padding:0; }
  body { font-family: 'Courier New', monospace; font-size: 12px; ${widthStyle} }
  @page { margin: 0; size: ${paperWidthMm ? `${paperWidthMm}mm` : "auto"} auto; }
</style>
</head><body><pre style="white-space: pre-wrap;">${escapedContent}</pre></body></html>`;

  debugLog(options?.debug, "Invoking print_html_native (text)...", {
    printer: printerName || "SYSTEM_DEFAULT",
    copies,
    paperSize: options?.paperSize,
  });

  try {
    const result = await invoke<string>("print_html_native", {
      html: receiptHtml,
      printerName,
      copies,
      paperSize: options?.paperSize ?? "Thermal 80mm",
    });

    debugLog(options?.debug, "Print result (text):", result);
    console.info("[tauriPrinter] silentPrintText result:", result);
    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("❌ [tauriPrinter] silentPrintText failed:", msg);
    throw new Error(msg);
  } finally {
    releasePrintLock();
  }
}
