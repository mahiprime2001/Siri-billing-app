import { getPrinters, printHtml } from "tauri-plugin-printer-v2";

export const isTauriApp = (): boolean => {
  return typeof window !== "undefined" && Boolean((window as any).__TAURI__);
};

export async function listPrinters(): Promise<string[]> {
  if (!isTauriApp()) return [];
  try {
    const printersJson = await getPrinters();
    const parsed = JSON.parse(printersJson);
    if (Array.isArray(parsed)) {
      return parsed.map((p) => p?.name).filter(Boolean);
    }
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
  await printHtml({
    html: `<pre style="font-family: 'Courier New', monospace; font-size: 12px; white-space: pre-wrap;">${content
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")}</pre>`,
    printer: printerName || undefined,
  });
}
