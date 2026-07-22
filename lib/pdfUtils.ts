// lib/pdfUtils.ts
// Save a rendered receipt element (e.g. PrintableDamageReturn) to a PDF file on the
// user's device. Uses html2canvas + jsPDF so it works identically in the browser
// and inside the Tauri desktop webview (both trigger a normal file download).

import jsPDF from "jspdf"
import html2canvas from "html2canvas"

const A4_MARGIN_MM = 15

export async function saveElementAsPdf(element: HTMLElement, filename: string): Promise<void> {
  const canvas = await html2canvas(element, {
    scale: 2,
    backgroundColor: "#ffffff",
  })

  const imgData = canvas.toDataURL("image/png")
  const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" })

  const pageWidthMm = pdf.internal.pageSize.getWidth()
  const pageHeightMm = pdf.internal.pageSize.getHeight()
  const maxWidthMm = pageWidthMm - A4_MARGIN_MM * 2
  const maxHeightMm = pageHeightMm - A4_MARGIN_MM * 2

  const aspect = canvas.height / canvas.width
  let renderWidthMm = maxWidthMm
  let renderHeightMm = renderWidthMm * aspect
  if (renderHeightMm > maxHeightMm) {
    renderHeightMm = maxHeightMm
    renderWidthMm = renderHeightMm / aspect
  }

  const x = (pageWidthMm - renderWidthMm) / 2
  pdf.addImage(imgData, "PNG", x, A4_MARGIN_MM, renderWidthMm, renderHeightMm)
  pdf.save(filename)
}
