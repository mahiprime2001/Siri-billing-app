import { invoke } from "@tauri-apps/api/core";
import { getPrinters, printHtml } from "tauri-plugin-printer-v2";

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

export async function listPrinters(): Promise<string[]> {
  if (!isTauriApp()) return [];
  try {
    debugLog(undefined, "Listing printers via plugin...");
    const printersJson = await getPrinters();
    debugLog(undefined, "Raw printers JSON:", printersJson);
    const parsed = JSON.parse(printersJson);
    if (Array.isArray(parsed)) {
      const names = parsed.map((p) => p?.name).filter(Boolean);
      debugLog(undefined, "Parsed printers:", names);
      return names;
    }
    debugLog(undefined, "Printers JSON did not parse to array.");
    return [];
  } catch (error) {
    console.error("❌ [tauriPrinter] Failed to list printers:", error);
    return [];
  }
}

type SilentPrintOptions = {
  printerName?: string;
  paperSize?: string;
  copies?: number;
  debug?: boolean;
};

const getThermalWidthMm = (paperSize?: string): number | undefined => {
  if (!paperSize) return undefined;
  if (paperSize === "Thermal 58mm") return 58;
  if (paperSize === "Thermal 80mm") return 80;
  return undefined;
};

type HtmlPrintOptions = {
  printerName?: string;
  paperSize?: string;
  copies?: number;
  debug?: boolean;
};

const getPageSize = (paperSize?: string): string | undefined => {
  if (paperSize === "A4") return "A4";
  if (paperSize === "Letter") return "Letter";
  return undefined;
};

export async function silentPrintText(
  content: string,
  options?: SilentPrintOptions
): Promise<void> {
  if (!isTauriApp()) {
    throw new Error("Silent printing is only available in the desktop app.");
  }
  const printerName = options?.printerName;
  const copies = Math.max(
    1,
    Number.isFinite(options?.copies) ? Number(options?.copies) : 2 // Default to 2 copies
  );
  const paperWidthMm = getThermalWidthMm(options?.paperSize);
  debugLog(options?.debug, "Printing via plugin (text)...", {
    printer: printerName || "SYSTEM_DEFAULT",
    copies,
    paperSize: options?.paperSize,
    contentLength: content.length,
  });
  const textPrintOptions = {
    id: `receipt-${Date.now()}`,
    html: `<pre style="font-family: 'Courier New', monospace; font-size: 12px; white-space: pre-wrap;${
      paperWidthMm ? ` width: ${paperWidthMm}mm;` : ""
    }">${content
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")}</pre>`,
    printer: printerName || "",
    copies,
    ...(paperWidthMm ? { page_width: paperWidthMm } : {}),
  };
  const result = await printHtml(textPrintOptions);
  debugLog(options?.debug, "Print job submitted (text).", result);
}

/**
 * ✅ MAIN PRINT FUNCTION - Prints HTML with NO headers/footers
 * - Defaults to 2 copies
 * - Prints content-only (no blank space after)
 * - Uses tauri-plugin-printer-v2 directly
 */
export async function printHtmlContent(
  html: string,
  options?: HtmlPrintOptions
): Promise<void> {
  if (!isTauriApp()) {
    throw new Error("HTML printing is only available in the desktop app.");
  }
  
  const printerName = options?.printerName;
  const copies = Math.max(
    1,
    Number.isFinite(options?.copies) ? Number(options?.copies) : 2 // ✅ DEFAULT 2 COPIES
  );
  const pageWidthMm = getThermalWidthMm(options?.paperSize);
  const pageSize = getPageSize(options?.paperSize);
  
  debugLog(options?.debug, "Printing via plugin (HTML)...", {
    printer: printerName || "SYSTEM_DEFAULT",
    copies,
    paperSize: options?.paperSize,
    htmlLength: html.length,
  });
  
  // ✅ Clean HTML - remove any duplicate rendering
  const cleanedHtml = html.replace(/<div class="print-copy">[\s\S]*?<\/div>/g, '');
  
  const htmlPrintOptions = {
    id: `invoice-${Date.now()}`,
    html: cleanedHtml,
    printer: printerName || "",
    orientation: "portrait" as const,
    copies, // ✅ 2 copies by default
    ...(pageWidthMm ? { page_width: pageWidthMm } : {}),
    ...(pageSize ? { page_size: pageSize } : {}),
  };
  
  const result = await printHtml(htmlPrintOptions);
  debugLog(options?.debug, "Print job submitted (HTML).", result);
}