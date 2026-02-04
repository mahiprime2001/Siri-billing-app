import { invoke } from "@tauri-apps/api/core";

export const isTauriApp = (): boolean => {
  return typeof window !== "undefined" && Boolean((window as any).__TAURI__);
};

export async function listPrinters(): Promise<string[]> {
  if (!isTauriApp()) return [];
  try {
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
  await invoke("print_text", {
    content,
    printer_name: printerName || null,
  });
}
