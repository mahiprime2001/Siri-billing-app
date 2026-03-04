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
  copies?: number;
  debug?: boolean;
};

let printInProgress = false;

// ── Build a complete, self-contained HTML document for printing ────────────
// This ensures your invoice design is preserved exactly as-is.

function buildPrintHtml(htmlContent: string, paperSize?: string): string {
  // Determine page width for thermal printers
  let pageWidth = "210mm"; // A4 default
  let pageHeight = "auto";

  if (paperSize === "Thermal 80mm") {
    pageWidth = "80mm";
  } else if (paperSize === "Thermal 58mm") {
    pageWidth = "58mm";
  } else if (paperSize === "A4") {
    pageWidth = "210mm";
    pageHeight = "297mm";
  } else if (paperSize === "Letter") {
    pageWidth = "216mm";
    pageHeight = "279mm";
  }

  // Extract body content if a full HTML document was passed in
  let content = htmlContent;
  const bodyMatch = htmlContent.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) {
    content = bodyMatch[1];
  }

  // Strip scripts and comments for safety
  content = content.replace(/<script[\s\S]*?<\/script>/gi, "");
  content = content.replace(/<!--[\s\S]*?-->/g, "");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Invoice</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      font-family: Arial, sans-serif;
      font-size: 12px;
      line-height: 1.4;
      background: #fff;
      width: ${pageWidth};
      ${pageHeight !== "auto" ? `height: ${pageHeight};` : ""}
    }
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
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 4px 8px; text-align: left; border-bottom: 1px solid #ddd; font-size: 11px; }
    .text-center { text-align: center; }
    .text-right { text-align: right; }
    .font-bold { font-weight: bold; }
  </style>
</head>
<body>
  ${content}
</body>
</html>`;
}

// ── MAIN FUNCTION: Print HTML directly to printer with N copies ────────────
//
// Calls the Rust `print_html_native` command which:
//   1. Writes HTML to a temp file
//   2. Uses PowerShell + IE COM automation to print silently
//   3. No dialog, no PDF, no wkhtmltopdf required
//   4. Supports exact copy count
//
export async function printHtmlContent(
  html: string,
  options?: HtmlPrintOptions
): Promise<string> {
  if (!isTauriApp()) {
    throw new Error("HTML printing is only available in the desktop app.");
  }

  if (printInProgress) {
    const msg = "Print already in progress. Skipping duplicate call.";
    debugLog(options?.debug, msg);
    return msg;
  }

  const printerName = options?.printerName ?? "";
  const copies = Math.max(
    1,
    Number.isFinite(options?.copies) ? Number(options?.copies) : 2
  );

  debugLog(options?.debug, "Invoking print_html_native...", {
    printer: printerName || "SYSTEM_DEFAULT",
    copies,
    paperSize: options?.paperSize,
    htmlLength: html.length,
  });

  // Build a clean, complete HTML document preserving your invoice design
  const printReadyHtml = buildPrintHtml(html, options?.paperSize);

  try {
    printInProgress = true;
    const result = await invoke<string>("print_html_native", {
      html: printReadyHtml,
      printerName,
      copies,
    });

    debugLog(options?.debug, "Print result:", result);
    console.info("[tauriPrinter] printHtmlContent result:", result);
    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("❌ [tauriPrinter] printHtmlContent failed:", msg);
    throw new Error(msg);
  } finally {
    printInProgress = false;
  }
}

// ── Text/receipt printing (unchanged logic, uses same native command) ──────

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

  if (printInProgress) {
    const msg = "Print already in progress. Skipping duplicate call.";
    debugLog(options?.debug, msg);
    return msg;
  }

  const printerName = options?.printerName ?? "";
  const copies = Math.max(
    1,
    Number.isFinite(options?.copies) ? Number(options?.copies) : 2
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
    printInProgress = true;
    const result = await invoke<string>("print_html_native", {
      html: receiptHtml,
      printerName,
      copies,
    });

    debugLog(options?.debug, "Print result (text):", result);
    console.info("[tauriPrinter] silentPrintText result:", result);
    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error("❌ [tauriPrinter] silentPrintText failed:", msg);
    throw new Error(msg);
  } finally {
    printInProgress = false;
  }
}
