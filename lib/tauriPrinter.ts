import { invoke } from "@tauri-apps/api/core";
import { getPrinters, printHtml } from "tauri-plugin-printer-v2";

export const isTauriApp = (): boolean => {
  return typeof window !== "undefined" && Boolean((window as any).__TAURI__);
};

export async function listPrinters(): Promise<string[]> {
  if (!isTauriApp()) return [];
  try {
    try {
      const printersJson = await getPrinters();
      const parsed = JSON.parse(printersJson);
      if (Array.isArray(parsed)) {
        return parsed.map((p) => p?.name).filter(Boolean);
      }
    } catch (error) {
      console.warn("⚠️ [tauriPrinter] Printer plugin failed, falling back:", error);
    }

    return await invoke<string[]>("list_printers");
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
  // Prefer printer plugin when available, fallback to PowerShell text print
  try {
    await printHtml({
      html: `<pre style="font-family: 'Courier New', monospace; font-size: 12px; white-space: pre-wrap;">${content
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")}</pre>`,
      printer: printerName || undefined,
    });
    return;
  } catch (error) {
    console.warn("⚠️ [tauriPrinter] HTML print failed, falling back:", error);
  }

  await invoke("print_text", {
    content,
    printer_name: printerName || null,
  });
}
