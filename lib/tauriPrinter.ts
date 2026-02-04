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

const debugLog = (...args: unknown[]) => {
  if (isPrinterDebugEnabled()) {
    console.debug("🖨️ [tauriPrinter]", ...args);
  }
};

export async function listPrinters(): Promise<string[]> {
  if (!isTauriApp()) return [];
  try {
    debugLog("Listing printers via plugin...");
    const printersJson = await getPrinters();
    debugLog("Raw printers JSON:", printersJson);
    const parsed = JSON.parse(printersJson);
    if (Array.isArray(parsed)) {
      const names = parsed.map((p) => p?.name).filter(Boolean);
      debugLog("Parsed printers:", names);
      return names;
    }
    debugLog("Printers JSON did not parse to array.");
    return [];
  } catch (error) {
    console.error("❌ [tauriPrinter] Failed to list printers:", error);
    return [];
  }
}

export async function silentPrintText(
  content: string,
  printerName?: string
): Promise<void> {
  if (!isTauriApp()) {
    throw new Error("Silent printing is only available in the desktop app.");
  }
  debugLog("Printing via plugin...", {
    printer: printerName || "SYSTEM_DEFAULT",
    contentLength: content.length,
  });
  await printHtml({
    html: `<pre style="font-family: 'Courier New', monospace; font-size: 12px; white-space: pre-wrap;">${content
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")}</pre>`,
    printer: printerName || undefined,
  });
  debugLog("Print job submitted.");
}
