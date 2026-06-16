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
import { Trash2, Search, ScanLine, ArrowLeft, Printer, RefreshCw } from "lucide-react"
import { apiClient } from "@/lib/api-client"
import { useToast } from "@/hooks/use-toast"
import { isTauriApp, listPrinters, printHtmlContent } from "@/lib/tauriPrinter"
import { safePrint } from "@/lib/printUtils"
import PrintableDamageReturn, { DamageReturnPrintData } from "@/components/printable-damage-return"

interface ProductSearchResult {
  id: string
  name: string
  barcode?: string
  barcodes?: string
  stock?: number
}

interface SelectedItem {
  productId: string
  name: string
  barcode?: string
  quantity: number
  availableStock: number
}

interface DamageReturnRow {
  id: string
  store_id?: string
  product_id?: string
  quantity?: number
  reason?: string
  reason_type?: string
  damage_origin?: string
  status?: string
  resolution_status?: string
  notes?: string
  created_by?: string
  created_at?: string
  products?: { id: string; name?: string; barcode?: string } | null
  stores?: { id: string; name?: string } | null
}

interface DamageReturnGroup {
  key: string
  createdAt?: string
  reason?: string
  reasonType?: string
  damageOrigin?: string
  status?: string
  resolutionStatus?: string
  storeName?: string
  createdBy?: string
  rows: DamageReturnRow[]
  totalQty: number
}

const REASONS = [
  { value: "damaged", label: "Damaged" },
  { value: "modification", label: "Needs Modification" },
  { value: "low_sales", label: "Low Sales" },
  { value: "sold_offline", label: "Sold Offline" },
]

const PAPER_SIZE = "Thermal 80mm"
const SYSTEM_DEFAULT_PRINTER_VALUE = "__SYSTEM_DEFAULT__"
const PRINTER_STORAGE_KEY = "siri_selected_printer_history"

const normalizeBarcode = (value: string) => value.trim().replace(/^0+/, "")

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
        @page { size: 80mm auto; margin: 0; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body {
          font-family: "Courier New", monospace;
          font-size: 12px;
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
          @page { margin: 0; }
        }
        .print-container {
          width: 100%;
          max-width: 80mm;
          margin: 0 auto;
          padding: 0 4mm;
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

export default function ReturnToAdminPage() {
  const router = useRouter()
  const { toast } = useToast()

  // form state
  const [barcodeInput, setBarcodeInput] = useState("")
  const [reasonType, setReasonType] = useState("")
  const [items, setItems] = useState<SelectedItem[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  // context for receipt header
  const [companyName, setCompanyName] = useState("")
  const [store, setStore] = useState<{ name?: string; address?: string; phone?: string } | null>(null)

  // history state
  const [history, setHistory] = useState<DamageReturnRow[]>([])
  const [isLoadingHistory, setIsLoadingHistory] = useState(false)

  // print state
  const printRef = useRef<HTMLDivElement>(null)
  const [isTauriRuntime, setIsTauriRuntime] = useState(false)
  const [showPrintDialog, setShowPrintDialog] = useState(false)
  const [printData, setPrintData] = useState<DamageReturnPrintData | null>(null)
  const [printCopies, setPrintCopies] = useState(1)
  const [printers, setPrinters] = useState<string[]>([])
  const [isLoadingPrinters, setIsLoadingPrinters] = useState(false)
  const [isPrinting, setIsPrinting] = useState(false)
  const [selectedPrinter, setSelectedPrinter] = useState(SYSTEM_DEFAULT_PRINTER_VALUE)

  const canSubmit = items.length > 0 && !!reasonType && !isSubmitting

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
      const response = await apiClient("/api/store-damage-returns?limit=200")
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = (await response.json()) as DamageReturnRow[]
      setHistory(Array.isArray(data) ? data : [])
    } catch (error) {
      console.error("Failed to fetch return history:", error)
      toast({
        title: "Failed to load history",
        description: "Could not fetch previous returns.",
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

  // Group history rows by submission batch (same created_at).
  const historyGroups = useMemo<DamageReturnGroup[]>(() => {
    const map = new Map<string, DamageReturnGroup>()
    for (const row of history) {
      const key = `${row.created_at || ""}|${row.reason || ""}|${row.created_by || ""}`
      let group = map.get(key)
      if (!group) {
        group = {
          key,
          createdAt: row.created_at,
          reason: row.reason,
          reasonType: row.reason_type,
          damageOrigin: row.damage_origin,
          status: row.status,
          resolutionStatus: row.resolution_status,
          storeName: row.stores?.name,
          createdBy: row.created_by,
          rows: [],
          totalQty: 0,
        }
        map.set(key, group)
      }
      group.rows.push(row)
      group.totalQty += Number(row.quantity || 0)
    }
    return Array.from(map.values())
  }, [history])

  const goBackToCart = () => {
    router.push("/billing")
  }

  const addOrIncrementItem = (product: ProductSearchResult): boolean => {
    const availableStock = Number.isFinite(Number(product.stock)) ? Math.max(0, Number(product.stock)) : 0

    if (availableStock <= 0) {
      toast({
        title: "Out of Stock",
        description: `${product.name} is not available in stock.`,
        variant: "destructive",
      })
      return false
    }

    const existing = items.find((item) => item.productId === product.id)
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
          item.productId === product.id
            ? { ...item, quantity: item.quantity + 1, availableStock }
            : item,
        ),
      )
      return true
    }

    setItems((prev) => [
      ...prev,
      {
        productId: product.id,
        name: product.name,
        barcode: product.barcode || product.barcodes,
        quantity: 1,
        availableStock,
      },
    ])
    return true
  }

  const handleQtyChange = (productId: string, value: number) => {
    const next = Math.max(1, Number.isFinite(value) ? Math.floor(value) : 1)
    const existing = items.find((item) => item.productId === productId)
    if (!existing) return

    if (next > existing.availableStock) {
      toast({
        title: "Stock Limit Reached",
        description: `Only ${existing.availableStock} available for ${existing.name}.`,
        variant: "destructive",
      })
      setItems((prev) =>
        prev.map((item) =>
          item.productId === productId ? { ...item, quantity: existing.availableStock } : item,
        ),
      )
      return
    }
    setItems((prev) =>
      prev.map((item) => (item.productId === productId ? { ...item, quantity: next } : item)),
    )
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

  const handleRemove = (productId: string) => {
    setItems((prev) => prev.filter((item) => item.productId !== productId))
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

  const handlePrintHistoryGroup = (group: DamageReturnGroup) => {
    openPrintDialog({
      id: group.rows[0]?.id,
      companyName,
      storeName: group.storeName || store?.name,
      storeAddress: store?.address,
      storePhone: store?.phone,
      createdAt: group.createdAt,
      reason: group.reason,
      reasonType: group.reasonType,
      damageOrigin: group.damageOrigin,
      status: group.status,
      resolutionStatus: group.resolutionStatus,
      createdBy: group.createdBy,
      items: group.rows.map((row) => ({
        name: row.products?.name || "Unknown Product",
        barcode: row.products?.barcode,
        quantity: Number(row.quantity || 0),
      })),
    })
  }

  const handleConfirmPrint = async () => {
    if (!printData) return
    setIsPrinting(true)
    try {
      await new Promise((resolve) => setTimeout(resolve, 0))
      const printOuter = printRef.current?.outerHTML || ""
      if (!printOuter) {
        throw new Error("Print content is not ready yet")
      }

      const printContent = buildPrintHTML(printOuter, printData.id || "return")
      const copies = Math.max(1, Math.trunc(Number(printCopies || 1)))

      if (isTauriRuntime) {
        const printerName = selectedPrinter === SYSTEM_DEFAULT_PRINTER_VALUE ? "" : selectedPrinter
        await printHtmlContent(printContent, { paperSize: PAPER_SIZE, printerName, copies })
        toast({
          title: "Print job queued",
          description: `Printer: ${printerName || "System default"} • Copies: ${copies}`,
        })
      } else {
        const result = await safePrint(printContent, PAPER_SIZE)
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
        selectedItems: items.map((item) => ({
          productId: item.productId,
          quantity: item.quantity,
        })),
        reason: REASONS.find((entry) => entry.value === reasonType)?.label || reasonType,
        reasonType,
        damageOrigin: "store",
      }

      const response = await apiClient("/api/store-damage-returns", {
        method: "POST",
        body: JSON.stringify(payload),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(result?.message || `HTTP ${response.status}`)
      }

      const reasonLabel = REASONS.find((entry) => entry.value === reasonType)?.label || reasonType
      const createdRefId: string | undefined = result?.rows?.[0]?.id

      // Snapshot the receipt before clearing the form.
      const receipt: DamageReturnPrintData = {
        id: createdRefId,
        companyName,
        storeName: store?.name,
        storeAddress: store?.address,
        storePhone: store?.phone,
        createdAt: result?.rows?.[0]?.created_at || new Date().toISOString(),
        reason: reasonLabel,
        reasonType,
        damageOrigin: "store",
        status: "sent_to_admin",
        items: items.map((item) => ({
          name: item.name,
          barcode: item.barcode,
          quantity: item.quantity,
        })),
      }

      toast({
        title: "Sent to Admin",
        description: `Submitted ${items.length} product(s) (Qty ${totalQty}).`,
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
              Scan or enter product barcodes, select a reason, and send items back to admin.
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
            <div className="flex gap-2">
              <div className="flex-1">
                <Label htmlFor="return-barcode">Barcode</Label>
                <Input
                  id="return-barcode"
                  placeholder="Scan or enter barcode"
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
              <Button onClick={handleSearch} disabled={isSearching} className="mt-6">
                <Search className="h-4 w-4 mr-2" />
                {isSearching ? "Searching..." : "Add"}
              </Button>
            </div>

            <div className="space-y-2">
              <Label>Reason</Label>
              <Select value={reasonType} onValueChange={setReasonType}>
                <SelectTrigger>
                  <SelectValue placeholder="Select reason" />
                </SelectTrigger>
                <SelectContent>
                  {REASONS.map((entry) => (
                    <SelectItem key={entry.value} value={entry.value}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>Barcode</TableHead>
                    <TableHead className="w-32">Qty</TableHead>
                    <TableHead className="w-20"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center text-muted-foreground py-6">
                        No products added yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    items.map((item) => (
                      <TableRow key={item.productId}>
                        <TableCell className="font-medium">{item.name}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {item.barcode || "-"}
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            min={1}
                            value={item.quantity}
                            onChange={(e) => handleQtyChange(item.productId, Number(e.target.value))}
                          />
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleRemove(item.productId)}
                          >
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
              {!reasonType && items.length > 0 && (
                <span className="text-xs text-destructive">Reason is required.</span>
              )}
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
              <h2 className="text-sm font-medium text-muted-foreground">
                Previous returns to admin
              </h2>
              <Button variant="outline" size="sm" onClick={fetchHistory} disabled={isLoadingHistory}>
                <RefreshCw className={`h-4 w-4 mr-2 ${isLoadingHistory ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>

            {isLoadingHistory ? (
              <p className="text-sm text-muted-foreground py-8 text-center">Loading history...</p>
            ) : historyGroups.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">No returns yet.</p>
            ) : (
              <div className="space-y-3">
                {historyGroups.map((group) => (
                  <div key={group.key} className="rounded-md border p-3 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="space-y-1">
                        <div className="text-sm font-medium">{formatDateTime(group.createdAt)}</div>
                        <div className="flex flex-wrap gap-2">
                          <Badge variant="secondary">{group.reason || titleCase(group.reasonType)}</Badge>
                          <Badge variant="outline">{titleCase(group.status)}</Badge>
                          {group.resolutionStatus && (
                            <Badge variant="outline">{titleCase(group.resolutionStatus)}</Badge>
                          )}
                          <Badge variant="outline">Qty: {group.totalQty}</Badge>
                        </div>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handlePrintHistoryGroup(group)}
                      >
                        <Printer className="h-4 w-4 mr-2" />
                        Print
                      </Button>
                    </div>
                    <div className="rounded border bg-muted/20">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Product</TableHead>
                            <TableHead>Barcode</TableHead>
                            <TableHead className="w-20 text-right">Qty</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {group.rows.map((row) => (
                            <TableRow key={row.id}>
                              <TableCell className="font-medium">
                                {row.products?.name || "Unknown Product"}
                              </TableCell>
                              <TableCell className="text-xs text-muted-foreground">
                                {row.products?.barcode || "-"}
                              </TableCell>
                              <TableCell className="text-right">{row.quantity}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                ))}
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
              This will submit {items.length} product(s) (Qty {totalQty}) to admin and reduce stock.
              Continue?
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

      {/* Hidden printable used as the print source */}
      <div className="hidden print:block">
        {printData && <PrintableDamageReturn ref={printRef} data={printData} paperSize={PAPER_SIZE} />}
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
                <PrintableDamageReturn data={printData} paperSize={PAPER_SIZE} />
              ) : (
                <p className="text-sm text-muted-foreground">Nothing selected for preview.</p>
              )}
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowPrintDialog(false)} disabled={isPrinting}>
              Close
            </Button>
            <Button onClick={handleConfirmPrint} disabled={!printData || isPrinting}>
              {isPrinting ? "Printing..." : "Print"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
