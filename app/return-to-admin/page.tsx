"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Trash2, Search, ScanLine, ArrowLeft, Printer, RefreshCw, FileDown } from "lucide-react"
import { apiClient } from "@/lib/api-client"
import { useToast } from "@/hooks/use-toast"
import { isTauriApp, listPrinters, printHtmlContent } from "@/lib/tauriPrinter"
import { safePrint } from "@/lib/printUtils"
import { saveElementAsPdf } from "@/lib/pdfUtils"
import PrintableDamageReturn, { DamageReturnPrintData } from "@/components/printable-damage-return"

interface ProductSearchResult {
  id: string
  name: string
  barcode?: string
  barcodes?: string
  stock?: number
  selling_price?: number
}

interface SelectedItem {
  lineId: string
  productId: string
  name: string
  barcode?: string
  quantity: number
  availableStock: number
  sellingPrice: number
  reasonType: string
}

interface ReturnOrderLine {
  id: string
  product_id?: string
  quantity?: number
  reason?: string
  reason_type?: string
  verify_status?: string
  holding_status?: string
  products?: { id: string; name?: string; barcode?: string; selling_price?: number } | null
}

interface ReturnOrder {
  return_id: string
  admin_status?: string
  return_quantity?: number
  message?: string
  created_at?: string
  created_by?: string
  return_products?: ReturnOrderLine[]
}

const REASONS = [
  { value: "damaged", label: "Damaged" },
  { value: "modification", label: "Needs Modification" },
  { value: "low_sales", label: "Low Sales" },
  { value: "other", label: "Other" },
]

// Physical printing matches the bill thermal format; "Save as PDF" stays A4
// regardless (a full-page document reads better as a saved/emailed file than
// a narrow receipt strip would). The two are decoupled via receiptPaperSize
// state below, not a single shared constant.
const PRINT_PAPER_SIZE = "Thermal 80mm"
const PDF_PAPER_SIZE = "A4"
const SYSTEM_DEFAULT_PRINTER_VALUE = "__SYSTEM_DEFAULT__"
const PRINTER_STORAGE_KEY = "siri_selected_printer_history"

const normalizeBarcode = (value: string) => value.trim().replace(/^0+/, "")

const reasonLabel = (value: string | undefined | null) =>
  REASONS.find((entry) => entry.value === value)?.label || titleCase(value)

const titleCase = (value: string | undefined | null) =>
  value ? String(value).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "-"

const formatDateTime = (value: string | undefined) => {
  if (!value) return "-"
  const raw = String(value).trim()
  const hasTz = /([zZ]|[+-]\d{2}:\d{2})$/.test(raw)
  const normalized = !hasTz && raw.includes("T") ? `${raw}+05:30` : raw
  const parsed = new Date(normalized)
  if (Number.isNaN(parsed.getTime())) return "-"
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(parsed)
}

const buildPrintHTML = (printContent: string, refId: string): string => `
  <!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>ReturnToAdmin-${refId}</title>
      <style>
        @page { size: A4; margin: 15mm; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body {
          font-family: "Courier New", monospace;
          font-size: 13px;
          line-height: 1.5;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
          background: white;
          color: black;
          height: auto;
          width: 100%;
        }
        @media print {
          html, body { margin: 0 !important; overflow: visible !important; height: auto !important; }
        }
        .print-container {
          width: 100%;
          max-width: 210mm;
          margin: 0 auto;
          padding: 0;
          box-sizing: border-box;
        }
      </style>
    </head>
    <body>
      <div class="print-container">
        ${printContent}
      </div>
    </body>
  </html>
`

const distinctReasons = (values: (string | undefined)[]) => {
  const labels = Array.from(new Set(values.map((v) => reasonLabel(v)).filter((v) => v && v !== "-")))
  return labels.join(", ") || "-"
}

export default function ReturnToAdminPage() {
  const router = useRouter()
  const { toast } = useToast()

  // form state. `reasonType` is the ACTIVE reason applied to newly scanned items.
  const [barcodeInput, setBarcodeInput] = useState("")
  const [reasonType, setReasonType] = useState("")
  const [items, setItems] = useState<SelectedItem[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  // context for receipt header
  const [companyName, setCompanyName] = useState("")
  const [store, setStore] = useState<{ name?: string; address?: string; phone?: string } | null>(null)

  // history state (one entry per return order)
  const [history, setHistory] = useState<ReturnOrder[]>([])
  const [isLoadingHistory, setIsLoadingHistory] = useState(false)

  // print state
  const printRef = useRef<HTMLDivElement>(null)
  const [isTauriRuntime, setIsTauriRuntime] = useState(false)
  const [showPrintDialog, setShowPrintDialog] = useState(false)
  const [printData, setPrintData] = useState<DamageReturnPrintData | null>(null)
  // Drives what the offscreen PrintableDamageReturn (the shared source for
  // both native print and PDF capture) actually renders. Defaults to the
  // thermal print format; PDF-save handlers switch it to PDF_PAPER_SIZE for
  // the duration of the capture and restore it afterward.
  const [receiptPaperSize, setReceiptPaperSize] = useState<string>(PRINT_PAPER_SIZE)
  const [printCopies, setPrintCopies] = useState(1)
  const [printers, setPrinters] = useState<string[]>([])
  const [isLoadingPrinters, setIsLoadingPrinters] = useState(false)
  const [isPrinting, setIsPrinting] = useState(false)
  const [selectedPrinter, setSelectedPrinter] = useState(SYSTEM_DEFAULT_PRINTER_VALUE)

  // save-to-device (PDF) state
  const [savingPdfId, setSavingPdfId] = useState<string | null>(null)
  const [isSavingCurrentPdf, setIsSavingCurrentPdf] = useState(false)

  // True while any operation is using the shared offscreen receipt (print
  // dialog printing/saving, or a history-row PDF save) — that receipt's
  // paperSize toggles between thermal (print) and A4 (PDF) during capture,
  // so overlapping actions could race and capture the wrong format.
  const isReceiptBusy = isPrinting || isSavingCurrentPdf || savingPdfId !== null

  const canSubmit = items.length > 0 && !isSubmitting

  const totalQty = useMemo(
    () => items.reduce((sum, item) => sum + (item.quantity || 0), 0),
    [items],
  )

  useEffect(() => {
    setIsTauriRuntime(isTauriApp())
  }, [])

  useEffect(() => {
    if (typeof window === "undefined") return
    const saved = window.localStorage.getItem(PRINTER_STORAGE_KEY)
    if (saved?.trim()) setSelectedPrinter(saved)
  }, [])

  useEffect(() => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(PRINTER_STORAGE_KEY, selectedPrinter)
  }, [selectedPrinter])

  const fetchSettings = useCallback(async () => {
    try {
      const response = await apiClient("/api/settings", { method: "GET" })
      if (!response.ok) return
      const data = await response.json()
      setCompanyName(data?.companyName || "")
    } catch (error) {
      console.error("Failed to fetch settings:", error)
    }
  }, [])

  const fetchStore = useCallback(async () => {
    try {
      const response = await apiClient("/api/stores/current")
      if (!response.ok) return
      const data = await response.json()
      setStore({ name: data?.name, address: data?.address, phone: data?.phone })
    } catch (error) {
      console.error("Failed to fetch store:", error)
    }
  }, [])

  const fetchHistory = useCallback(async () => {
    setIsLoadingHistory(true)
    try {
      const response = await apiClient("/api/return-orders?limit=200")
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = (await response.json()) as ReturnOrder[]
      setHistory(Array.isArray(data) ? data : [])
    } catch (error) {
      console.error("Failed to fetch return history:", error)
      toast({
        title: "Failed to load history",
        description: "Could not fetch previous return orders.",
        variant: "destructive",
      })
    } finally {
      setIsLoadingHistory(false)
    }
  }, [toast])

  useEffect(() => {
    fetchSettings()
    fetchStore()
    fetchHistory()
  }, [fetchSettings, fetchStore, fetchHistory])

  const goBackToCart = () => {
    router.push("/billing")
  }

  // New scans are tagged with the currently-selected reason. Re-scanning the same
  // product under the same reason increments that line; the same product under a
  // different reason becomes a separate line.
  const addOrIncrementItem = (product: ProductSearchResult): boolean => {
    if (!reasonType) {
      toast({
        title: "Select a reason first",
        description: "Pick the reason, then scan the products for that reason.",
        variant: "destructive",
      })
      return false
    }

    const availableStock = Number.isFinite(Number(product.stock)) ? Math.max(0, Number(product.stock)) : 0
    if (availableStock <= 0) {
      toast({
        title: "Out of Stock",
        description: `${product.name} is not available in stock.`,
        variant: "destructive",
      })
      return false
    }

    const lineId = `${product.id}__${reasonType}`
    const existing = items.find((item) => item.lineId === lineId)
    if (existing) {
      if (existing.quantity >= existing.availableStock) {
        toast({
          title: "Stock Limit Reached",
          description: `No more stock available for ${product.name}.`,
          variant: "destructive",
        })
        return false
      }
      setItems((prev) =>
        prev.map((item) =>
          item.lineId === lineId ? { ...item, quantity: item.quantity + 1, availableStock } : item,
        ),
      )
      return true
    }

    setItems((prev) => [
      ...prev,
      {
        lineId,
        productId: product.id,
        name: product.name,
        barcode: product.barcode || product.barcodes,
        quantity: 1,
        availableStock,
        sellingPrice: Number(product.selling_price || 0),
        reasonType,
      },
    ])
    return true
  }

  const handleQtyChange = (lineId: string, value: number) => {
    const next = Math.max(1, Number.isFinite(value) ? Math.floor(value) : 1)
    const existing = items.find((item) => item.lineId === lineId)
    if (!existing) return

    if (next > existing.availableStock) {
      toast({
        title: "Stock Limit Reached",
        description: `Only ${existing.availableStock} available for ${existing.name}.`,
        variant: "destructive",
      })
      setItems((prev) =>
        prev.map((item) =>
          item.lineId === lineId ? { ...item, quantity: existing.availableStock } : item,
        ),
      )
      return
    }
    setItems((prev) => prev.map((item) => (item.lineId === lineId ? { ...item, quantity: next } : item)))
  }

  // Change a single line's reason. If a line for the same product + new reason
  // already exists, merge the quantities into it.
  const handleChangeItemReason = (lineId: string, newReason: string) => {
    setItems((prev) => {
      const target = prev.find((item) => item.lineId === lineId)
      if (!target || target.reasonType === newReason) return prev
      const newLineId = `${target.productId}__${newReason}`
      const sibling = prev.find((item) => item.lineId === newLineId)
      if (sibling) {
        const mergedQty = Math.min(sibling.availableStock, sibling.quantity + target.quantity)
        return prev
          .filter((item) => item.lineId !== lineId)
          .map((item) => (item.lineId === newLineId ? { ...item, quantity: mergedQty } : item))
      }
      return prev.map((item) =>
        item.lineId === lineId ? { ...item, lineId: newLineId, reasonType: newReason } : item,
      )
    })
  }

  const handleSearch = async () => {
    const raw = barcodeInput.trim()
    if (!raw) {
      toast({
        title: "Barcode Required",
        description: "Enter or scan a barcode to continue.",
        variant: "destructive",
      })
      return
    }

    setIsSearching(true)
    try {
      const normalized = normalizeBarcode(raw)
      const response = await apiClient(`/api/products?search=${encodeURIComponent(normalized)}&limit=10`)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }
      const results = (await response.json()) as ProductSearchResult[]
      const match = (results || []).find((product) => {
        const candidates = [product.barcode, product.barcodes]
          .filter(Boolean)
          .flatMap((entry) => String(entry).split(","))
          .map((value) => normalizeBarcode(value))
        return candidates.includes(normalized)
      }) || results?.[0]

      if (!match) {
        toast({
          title: "Product Not Found",
          description: `No product found for barcode: ${raw}`,
          variant: "destructive",
        })
        return
      }

      const added = addOrIncrementItem(match)
      if (added) {
        setBarcodeInput("")
      }
    } catch (error) {
      console.error("Barcode search failed:", error)
      toast({
        title: "Search Failed",
        description: "Could not find product. Check connection and try again.",
        variant: "destructive",
      })
    } finally {
      setIsSearching(false)
    }
  }

  const handleRemove = (lineId: string) => {
    setItems((prev) => prev.filter((item) => item.lineId !== lineId))
  }

  const resetForm = () => {
    setBarcodeInput("")
    setReasonType("")
    setItems([])
  }

  const loadPrinters = useCallback(async () => {
    if (!isTauriApp()) return
    setIsLoadingPrinters(true)
    try {
      const list = await listPrinters()
      setPrinters(list)
      setSelectedPrinter((prev) =>
        prev !== SYSTEM_DEFAULT_PRINTER_VALUE && prev && !list.includes(prev)
          ? SYSTEM_DEFAULT_PRINTER_VALUE
          : prev,
      )
    } finally {
      setIsLoadingPrinters(false)
    }
  }, [])

  const openPrintDialog = async (data: DamageReturnPrintData) => {
    setPrintData(data)
    setPrintCopies(1)
    setShowPrintDialog(true)
    await loadPrinters()
  }

  const buildReceiptData = (order: ReturnOrder): DamageReturnPrintData => {
    const lines = order.return_products || []
    return {
      id: order.return_id,
      companyName,
      storeName: store?.name,
      storeAddress: store?.address,
      storePhone: store?.phone,
      createdAt: order.created_at,
      reason: distinctReasons(lines.map((l) => l.reason_type)),
      status: order.admin_status,
      createdBy: order.created_by,
      items: lines.map((line) => ({
        name: line.products?.name || "Unknown Product",
        barcode: line.products?.barcode,
        quantity: Number(line.quantity || 0),
        sellingPrice: Number(line.products?.selling_price || 0),
      })),
    }
  }

  const handlePrintOrder = (order: ReturnOrder) => {
    openPrintDialog(buildReceiptData(order))
  }

  // Renders the order into the offscreen receipt (without opening the print
  // dialog) just long enough to rasterize and save it as a PDF.
  const handleSaveOrderPdf = async (order: ReturnOrder) => {
    setSavingPdfId(order.return_id)
    try {
      setPrintData(buildReceiptData(order))
      setReceiptPaperSize(PDF_PAPER_SIZE)
      await new Promise((resolve) => setTimeout(resolve, 60))
      if (!printRef.current) throw new Error("Receipt not ready. Try again.")
      await saveElementAsPdf(printRef.current, `return-to-admin-${order.return_id}.pdf`)
    } catch (error) {
      console.error("Save PDF failed:", error)
      toast({
        title: "Save Failed",
        description: error instanceof Error ? error.message : "Could not save PDF.",
        variant: "destructive",
      })
    } finally {
      setReceiptPaperSize(PRINT_PAPER_SIZE)
      setSavingPdfId(null)
    }
  }

  // Saves whatever receipt is currently open in the print dialog.
  const handleSaveCurrentPdf = async () => {
    if (!printData || !printRef.current) return
    setIsSavingCurrentPdf(true)
    try {
      setReceiptPaperSize(PDF_PAPER_SIZE)
      await new Promise((resolve) => setTimeout(resolve, 60))
      if (!printRef.current) throw new Error("Receipt not ready. Try again.")
      await saveElementAsPdf(printRef.current, `return-to-admin-${printData.id || "order"}.pdf`)
    } catch (error) {
      console.error("Save PDF failed:", error)
      toast({
        title: "Save Failed",
        description: error instanceof Error ? error.message : "Could not save PDF.",
        variant: "destructive",
      })
    } finally {
      setReceiptPaperSize(PRINT_PAPER_SIZE)
      setIsSavingCurrentPdf(false)
    }
  }

  const handleConfirmPrint = async () => {
    if (!printData) return
    setIsPrinting(true)
    try {
      // Defensive re-assert: the offscreen receipt is shared with the PDF
      // handlers, which briefly flip it to PDF_PAPER_SIZE. Buttons are now
      // disabled while either operation is in flight, but this keeps print
      // correct even if that ever changes.
      setReceiptPaperSize(PRINT_PAPER_SIZE)
      await new Promise((resolve) => setTimeout(resolve, 0))
      const printOuter = printRef.current?.outerHTML || ""
      if (!printOuter) {
        throw new Error("Print content is not ready yet")
      }

      const printContent = buildPrintHTML(printOuter, printData.id || "return")
      const copies = Math.max(1, Math.trunc(Number(printCopies || 1)))

      if (isTauriRuntime) {
        const printerName = selectedPrinter === SYSTEM_DEFAULT_PRINTER_VALUE ? "" : selectedPrinter
        await printHtmlContent(printContent, { paperSize: PRINT_PAPER_SIZE, printerName, copies })
        toast({
          title: "Print job queued",
          description: `Printer: ${printerName || "System default"} • Copies: ${copies}`,
        })
      } else {
        const result = await safePrint(printContent, PRINT_PAPER_SIZE)
        if (!result.success) {
          throw new Error(result.error || "Browser print failed")
        }
      }

      setShowPrintDialog(false)
    } catch (error) {
      console.error("❌ [ReturnToAdmin] Print failed:", error)
      toast({
        title: "Print Failed",
        description: error instanceof Error ? error.message : "Could not print receipt.",
        variant: "destructive",
      })
    } finally {
      setIsPrinting(false)
    }
  }

  const handleSubmit = async () => {
    if (!canSubmit) return
    setIsSubmitting(true)
    try {
      const payload = {
        items: items.map((item) => ({
          productId: item.productId,
          quantity: item.quantity,
          reasonType: item.reasonType,
          reason: reasonLabel(item.reasonType),
        })),
      }

      const response = await apiClient("/api/return-orders", {
        method: "POST",
        body: JSON.stringify(payload),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(result?.message || `HTTP ${response.status}`)
      }

      const createdRefId: string | undefined = result?.return?.return_id

      // Snapshot the receipt before clearing the form.
      const receipt: DamageReturnPrintData = {
        id: createdRefId,
        companyName,
        storeName: store?.name,
        storeAddress: store?.address,
        storePhone: store?.phone,
        createdAt: result?.return?.created_at || new Date().toISOString(),
        reason: distinctReasons(items.map((item) => item.reasonType)),
        status: "sent_to_admin",
        items: items.map((item) => ({
          name: item.name,
          barcode: item.barcode,
          quantity: item.quantity,
          sellingPrice: item.sellingPrice,
        })),
      }

      toast({
        title: result?.queued ? "Saved offline" : "Sent to Admin",
        description: result?.queued
          ? `Return order queued (Qty ${totalQty}); will sync when online.`
          : `Return order submitted with ${items.length} line(s) (Qty ${totalQty}).`,
      })

      setConfirmOpen(false)
      resetForm()
      fetchHistory()
      await openPrintDialog(receipt)
    } catch (error) {
      console.error("Return to admin failed:", error)
      toast({
        title: "Submission Failed",
        description: (error as Error).message || "Failed to submit items.",
        variant: "destructive",
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="flex items-center gap-3 p-4">
          <Button variant="outline" size="sm" onClick={goBackToCart}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Billing & Cart
          </Button>
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold">
              <ScanLine className="h-5 w-5" />
              Return to Admin
            </h1>
            <p className="text-sm text-muted-foreground">
              Pick a reason, scan the products for it, switch reason and scan more, then submit one return order.
            </p>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-3xl p-4">
        <Tabs defaultValue="new" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="new">New Return</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>

          {/* ── NEW RETURN ── */}
          <TabsContent value="new" className="mt-4 space-y-4">
            <div className="space-y-2">
              <Label>Reason for scanned items</Label>
              <Select value={reasonType} onValueChange={setReasonType}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a reason, then scan products" />
                </SelectTrigger>
                <SelectContent>
                  {REASONS.map((entry) => (
                    <SelectItem key={entry.value} value={entry.value}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Items you scan are added under this reason. Change it any time to scan items with a different reason.
              </p>
            </div>

            <div className="flex gap-2">
              <div className="flex-1">
                <Label htmlFor="return-barcode">Barcode</Label>
                <Input
                  id="return-barcode"
                  placeholder={reasonType ? "Scan or enter barcode" : "Select a reason first"}
                  autoFocus
                  value={barcodeInput}
                  onChange={(e) => setBarcodeInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      handleSearch()
                    }
                  }}
                />
              </div>
              <Button onClick={handleSearch} disabled={isSearching || !reasonType} className="mt-6">
                <Search className="h-4 w-4 mr-2" />
                {isSearching ? "Searching..." : "Add"}
              </Button>
            </div>

            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>Barcode</TableHead>
                    <TableHead className="w-40">Reason</TableHead>
                    <TableHead className="w-28">Qty</TableHead>
                    <TableHead className="w-16"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-muted-foreground py-6">
                        No products added yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    items.map((item) => (
                      <TableRow key={item.lineId}>
                        <TableCell className="font-medium">{item.name}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {item.barcode || "-"}
                        </TableCell>
                        <TableCell>
                          <Select
                            value={item.reasonType}
                            onValueChange={(value) => handleChangeItemReason(item.lineId, value)}
                          >
                            <SelectTrigger className="h-8">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {REASONS.map((entry) => (
                                <SelectItem key={entry.value} value={entry.value}>
                                  {entry.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            min={1}
                            value={item.quantity}
                            onChange={(e) => handleQtyChange(item.lineId, Number(e.target.value))}
                          />
                        </TableCell>
                        <TableCell>
                          <Button variant="ghost" size="icon" onClick={() => handleRemove(item.lineId)}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>

            <div className="flex items-center justify-between">
              <Badge variant="secondary">Total Qty: {totalQty}</Badge>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={goBackToCart}>
                Cancel
              </Button>
              <Button onClick={() => setConfirmOpen(true)} disabled={!canSubmit}>
                Submit to Admin
              </Button>
            </div>
          </TabsContent>

          {/* ── HISTORY ── */}
          <TabsContent value="history" className="mt-4 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-muted-foreground">Previous return orders</h2>
              <Button variant="outline" size="sm" onClick={fetchHistory} disabled={isLoadingHistory}>
                <RefreshCw className={`h-4 w-4 mr-2 ${isLoadingHistory ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>

            {isLoadingHistory ? (
              <p className="text-sm text-muted-foreground py-8 text-center">Loading history...</p>
            ) : history.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">No return orders yet.</p>
            ) : (
              <div className="space-y-3">
                {history.map((order) => {
                  const lines = order.return_products || []
                  const totalOrderQty =
                    Number(order.return_quantity || 0) ||
                    lines.reduce((sum, line) => sum + Number(line.quantity || 0), 0)
                  return (
                    <div key={order.return_id} className="rounded-md border p-3 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="space-y-1">
                          <div className="text-sm font-medium">{formatDateTime(order.created_at)}</div>
                          <div className="text-xs text-muted-foreground">Order: {order.return_id}</div>
                          <div className="flex flex-wrap gap-2">
                            <Badge variant="outline">{titleCase(order.admin_status)}</Badge>
                            <Badge variant="outline">Qty: {totalOrderQty}</Badge>
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleSaveOrderPdf(order)}
                            disabled={isReceiptBusy}
                          >
                            <FileDown className="h-4 w-4 mr-2" />
                            {savingPdfId === order.return_id ? "Saving..." : "Save PDF"}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handlePrintOrder(order)}
                            disabled={isReceiptBusy}
                          >
                            <Printer className="h-4 w-4 mr-2" />
                            Print
                          </Button>
                        </div>
                      </div>
                      <div className="rounded border bg-muted/20">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Product</TableHead>
                              <TableHead>Barcode</TableHead>
                              <TableHead className="w-32">Reason</TableHead>
                              <TableHead className="w-16 text-right">Qty</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {lines.map((line) => (
                              <TableRow key={line.id}>
                                <TableCell className="font-medium">
                                  {line.products?.name || "Unknown Product"}
                                </TableCell>
                                <TableCell className="text-xs text-muted-foreground">
                                  {line.products?.barcode || "-"}
                                </TableCell>
                                <TableCell>{reasonLabel(line.reason_type)}</TableCell>
                                <TableCell className="text-right">{line.quantity}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>

      {/* Confirm submit */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Return to Admin</AlertDialogTitle>
            <AlertDialogDescription>
              This will send {items.length} line(s) (Qty {totalQty}) to admin as one return order.
              Stock is removed when the admin verifies the items. Continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSubmitting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleSubmit} disabled={isSubmitting}>
              {isSubmitting ? "Submitting..." : "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Offscreen printable used as the print + PDF-save source. Positioned off
          canvas (not display:none) so html2canvas can rasterize it even when the
          print dialog isn't open. */}
      <div style={{ position: "fixed", top: 0, left: "-10000px", width: "794px", zIndex: -1 }}>
        {printData && <PrintableDamageReturn ref={printRef} data={printData} paperSize={receiptPaperSize} />}
      </div>

      {/* Print dialog (same UI/method as billing history) */}
      <Dialog open={showPrintDialog} onOpenChange={setShowPrintDialog}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Print Return Receipt</DialogTitle>
            <DialogDescription>
              {printData?.id ? `Ref: ${printData.id}` : "Select print options and confirm."}
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-3 md:border-r md:pr-4">
              <div className="space-y-2">
                <Label htmlFor="return-print-copies">No. of Copies</Label>
                <Input
                  id="return-print-copies"
                  type="number"
                  min={1}
                  step={1}
                  value={printCopies}
                  onChange={(e) => {
                    const value = Number(e.target.value)
                    setPrintCopies(Number.isFinite(value) && value > 0 ? Math.trunc(value) : 1)
                  }}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="return-printer-select">Printer</Label>
                {isTauriRuntime ? (
                  <Select
                    value={selectedPrinter}
                    onValueChange={setSelectedPrinter}
                    disabled={isLoadingPrinters}
                  >
                    <SelectTrigger id="return-printer-select">
                      <SelectValue placeholder={isLoadingPrinters ? "Loading printers..." : "Select printer"} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={SYSTEM_DEFAULT_PRINTER_VALUE}>System Default</SelectItem>
                      {printers.map((printer) => (
                        <SelectItem key={printer} value={printer}>
                          {printer}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input id="return-printer-select" value="Browser Print Dialog" disabled />
                )}
              </div>

              {isTauriRuntime && printers.length === 0 && !isLoadingPrinters && (
                <p className="text-xs text-muted-foreground">
                  No printers reported by Tauri. System default will be used.
                </p>
              )}
            </div>

            <div className="md:col-span-2 max-h-[70vh] overflow-y-auto rounded border bg-muted/20 p-2">
              {printData ? (
                <PrintableDamageReturn data={printData} paperSize={receiptPaperSize} />
              ) : (
                <p className="text-sm text-muted-foreground">Nothing selected for preview.</p>
              )}
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowPrintDialog(false)} disabled={isReceiptBusy}>
              Close
            </Button>
            <Button
              variant="outline"
              onClick={handleSaveCurrentPdf}
              disabled={!printData || isReceiptBusy}
            >
              <FileDown className="h-4 w-4 mr-2" />
              {isSavingCurrentPdf ? "Saving..." : "Save PDF"}
            </Button>
            <Button onClick={handleConfirmPrint} disabled={!printData || isReceiptBusy}>
              {isPrinting ? "Printing..." : "Print"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
