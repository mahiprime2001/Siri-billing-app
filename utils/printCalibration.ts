export function getThermalConfig(paperSize: string) {
  const is58 = paperSize === "Thermal 58mm"

  return {
    maxWidthPx: is58 ? 200 : 270,
    maxWidthMM: is58 ? 48 : 72,
    sideMarginCompensationPx: is58 ? 3 : 4,
    scale: 1,
  }
}

export function measureContentScale(element: HTMLElement, maxWidthPx: number) {
  const actualWidth = element.offsetWidth

  if (!actualWidth) return 1

  const scale = Math.min(1, maxWidthPx / actualWidth)

  return scale
}
