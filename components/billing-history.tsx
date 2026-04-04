"use client"

import { useState, useEffect, useCallback, useMemo, useRef, type MouseEvent } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
// Printing in history is now identical to billing-cart: direct print (no dialog)
import { Eye, Search, Printer, Pencil, History } from "lucide-react"
import PrintableInvoice from "./printable-invoice"
import { apiClient } from "@/lib/api-client"
import { isTauriApp, listPrinters, printHtmlContent } from "@/lib/tauriPrinter"
import { safePrint } from "@/lib/printUtils"
import { useToast } from "@/components/ui/use-toast"

// Raw invoice shape returned by backend (snake_case).
interface RawInvoice {
  [key: string]: any
}

interface BillReplacement {
  id?: string
  bill_id: string
  original_bill_id?: string
  replaced_product_id: string
  new_product_id: string
  quantity: number
  price?: number
  final_amount?: number
}

interface BillEvent {
  id: number
  type: string
  notification: string
  related_id: string
  created_at: string
}

interface BillingHistoryProps {
  currentStore: { id: string; name: string } | null
  onEditInvoice?: (invoiceId: string) => void
}

interface DayInvoiceGroup {
  dateKey: string
  invoices: Invoice[]
  totalBills: number
  totalValue: number
}

export function BillingHistory({ currentStore, onEditInvoice }: BillingHistoryProps) {
  const { toast } = useToast()
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [filteredInvoices, setFilteredInvoices] = useState<Invoice[]>([])
  const [searchTerm, setSearchTerm] = useState("")
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null)
  const [showPreview, setShowPreview] = useState(false)
  const [settings, setSettings] = useState<{
    gstin?: string
    companyName?: string
    companyAddress?: string
    companyPhone?: string
    companyEmail?: string
  } | null>(null)
  const printPaperSize = "Thermal 80mm"
  const printRef = useRef<HTMLDivElement>(null)
  const [isTauriRuntime, setIsTauriRuntime] = useState(false)
  const [printingInvoiceId, setPrintingInvoiceId] = useState<string | null>(null)
  const [showPrintDialog, setShowPrintDialog] = useState(false)
  const [historyPrintInvoice, setHistoryPrintInvoice] = useState<Invoice | null>(null)
  const [historyPrintCopies, setHistoryPrintCopies] = useState(1)
  const [historyPrinters, setHistoryPrinters] = useState<string[]>([])
  const [isLoadingHistoryPrinters, setIsLoadingHistoryPrinters] = useState(false)
  const [isHistoryPrinting, setIsHistoryPrinting] = useState(false)
  const [historySelectedPrinter, setHistorySelectedPrinter] = useState("__SYSTEM_DEFAULT__")
  const [showDailyReportDialog, setShowDailyReportDialog] = useState(false)
  const [selectedDayReport, setSelectedDayReport] = useState<DayInvoiceGroup | null>(null)
  const [dailyReportCopies, setDailyReportCopies] = useState(1)
  const [isDailyReportPrinting, setIsDailyReportPrinting] = useState(false)
  const [historySelectedPaperSize, setHistorySelectedPaperSize] = useState<string>("Thermal 80mm")
  const [clockNowMs, setClockNowMs] = useState(() => Date.now())
  const [showAuditDialog, setShowAuditDialog] = useState(false)
  const [auditEvents, setAuditEvents] = useState<BillEvent[]>([])
  const [auditInvoiceId, setAuditInvoiceId] = useState<string>("")
  const [isAuditLoading, setIsAuditLoading] = useState(false)
  const [isAuditLoadingMore, setIsAuditLoadingMore] = useState(false)
  const [auditSearchTerm, setAuditSearchTerm] = useState("")
  const [auditTypeFilter, setAuditTypeFilter] = useState<"all" | "invoice_revised" | "invoice_cancelled">("all")
  const [auditPage, setAuditPage] = useState(1)
  const [auditHasMore, setAuditHasMore] = useState(false)
  const [auditNextOffset, setAuditNextOffset] = useState(0)
  const auditFetchLimit = 50
  const auditPageSize = 10
  const [openDayKeys, setOpenDayKeys] = useState<string[]>([])

  const IST_TIMEZONE = "Asia/Kolkata"
  const HISTORY_PRINTER_STORAGE_KEY = "siri_selected_printer_history"
  const REPORT_PAPER_SIZE_KEY = "siri_report_paper_size"
  const SYSTEM_DEFAULT_PRINTER_VALUE = "__SYSTEM_DEFAULT__"

  const parseServerDate = (value: string | Date | undefined | null): Date | null => {
    if (!value) return null
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value
    }
    const raw = String(value).trim()
    if (!raw) return null
    const hasExplicitTimezone = /([zZ]|[+-]\d{2}:\d{2})$/.test(raw)
    // Backend stores bare timestamps as IST wall-clock (no tz suffix). Append +05:30
    // so the browser treats them as IST rather than UTC (which would shift dates by +5:30).
    const normalized = !hasExplicitTimezone && raw.includes("T") ? `${raw}+05:30` : raw
    const parsed = new Date(normalized)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }

  const toEpochMs = (value: string | Date | undefined | null): number => {
    const parsed = parseServerDate(value)
    return parsed ? parsed.getTime() : 0
  }

  const formatIstDateTime = (value: string | Date | undefined | null): string => {
    const parsed = parseServerDate(value)
    if (!parsed) return "-"
    return new Intl.DateTimeFormat("en-IN", {
      timeZone: IST_TIMEZONE,
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    }).format(parsed)
  }

  const getIstDateKey = (value: string) => {
    const date = parseServerDate(value)
    if (!date) return ""
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: IST_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date)
    const year = parts.find((part) => part.type === "year")?.value
    const month = parts.find((part) => part.type === "month")?.value
    const day = parts.find((part) => part.type === "day")?.value
    if (!year || !month || !day) return ""
    return `${year}-${month}-${day}`
  }

  const getTodayIstDateKey = () => {
    const now = new Date()
    return getIstDateKey(now.toISOString())
  }

  const formatIstDateKey = (dateKey: string) => {
    const date = new Date(`${dateKey}T00:00:00+05:30`)
    if (Number.isNaN(date.getTime())) return dateKey
    return new Intl.DateTimeFormat("en-IN", {
      timeZone: IST_TIMEZONE,
      day: "2-digit",
      month: "short",
      year: "numeric",
    }).format(date)
  }

  useEffect(() => {
    setIsTauriRuntime(isTauriApp())
  }, [])

  useEffect(() => {
    if (typeof window === "undefined") return
    const savedPrinter = window.localStorage.getItem(HISTORY_PRINTER_STORAGE_KEY)
    if (savedPrinter?.trim()) {
      setHistorySelectedPrinter(savedPrinter)
    }
  }, [])

  useEffect(() => {
    if (typeof window === "undefined") return
    const savedPaper = window.localStorage.getItem(REPORT_PAPER_SIZE_KEY)
    if (savedPaper?.trim()) {
      setHistorySelectedPaperSize(savedPaper)
    }
  }, [])

  useEffect(() => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(HISTORY_PRINTER_STORAGE_KEY, historySelectedPrinter)
  }, [historySelectedPrinter])

  useEffect(() => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(REPORT_PAPER_SIZE_KEY, historySelectedPaperSize)
  }, [historySelectedPaperSize])

  useEffect(() => {
    const ticker = setInterval(() => setClockNowMs(Date.now()), 1000)
    return () => clearInterval(ticker)
  }, [])

  const fetchSettings = useCallback(async () => {
    try {
      const response = await apiClient("/api/settings", { method: "GET" })
      if (!response.ok) return
      const data = await response.json()
      setSettings({
        gstin: data?.gstin || "",
        companyName: data?.companyName || "",
        companyAddress: data?.companyAddress || "",
        companyPhone: data?.companyPhone || "",
        companyEmail: data?.companyEmail || "",
      })
    } catch (error) {
      console.error("Failed to fetch settings for billing history:", error)
    }
  }, [])

  // ✅ Helper function to get customer name (handles both old and new formats)
  const getCustomerName = (invoice: Invoice): string => {
    if (invoice.customerName) return invoice.customerName
    if (invoice.customers?.name) return invoice.customers.name
    return "Walk-in Customer"
  }

  // ✅ Helper function to get customer phone (handles both old and new formats)
  const getCustomerPhone = (invoice: Invoice): string => {
    if (invoice.customerPhone) return invoice.customerPhone
    if (invoice.customers?.phone) return invoice.customers.phone
    return ""
  }

  // ✅ Helper function to get customer email (handles both old and new formats)
  const getCustomerEmail = (invoice: Invoice): string => {
    if (invoice.customerEmail) return invoice.customerEmail
    if (invoice.customers?.email) return invoice.customers.email
    return ""
  }

  // ✅ Helper function to get customer address (handles both old and new formats)
  const getCustomerAddress = (invoice: Invoice): string => {
    if (invoice.customerAddress) return invoice.customerAddress
    if (invoice.customers?.address) return invoice.customers.address
    return ""
  }

  // ✅ Helper function to get store name (handles both old and new formats)
  const getStoreName = (invoice: Invoice): string => {
    if (invoice.storeName) return invoice.storeName
    if (invoice.stores?.name) return invoice.stores.name
    if (invoice.companyName) return invoice.companyName
    return "Unknown Store"
  }

  // ✅ Helper function to get store address (handles both old and new formats)
  const getStoreAddress = (invoice: Invoice): string => {
    if (invoice.storeAddress) return invoice.storeAddress
    if (invoice.stores?.address) return invoice.stores.address
    if (invoice.companyAddress) return invoice.companyAddress
    return "123 Jewelry Street"
  }

  // ✅ Helper function to get store phone (handles both old and new formats)
  const getStorePhone = (invoice: Invoice): string => {
    if (invoice.storePhone) return invoice.storePhone
    if (invoice.stores?.phone) return invoice.stores.phone
    if (invoice.companyPhone) return invoice.companyPhone
    return "+91 98765 43210"
  }

  const fetchBillingHistory = useCallback(async () => {
  if (!currentStore) {
    console.log("No current store selected")
    return
  }

  try {
    console.log(`Fetching billing history for store: ${currentStore.id}`)

    // ❌ DO NOT read localStorage here
    // ❌ DO NOT set Authorization header here
    // ✅ Let apiClient + authManager handle the token

    const response = await apiClient(
      `/api/bills?store_id=${currentStore.id}&limit=500`,
      {
        method: "GET",
      }
    )

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }

    const usedFallback = response.headers.get("X-Bills-Fallback-Used") === "1"
    const bills: RawInvoice[] = await response.json()

    const normalized = bills.map((b) => ({
      id: b.id,
      storeId: b.storeid || b.store_id || b.storeId || "",
      storeName: b.storeName || b.stores?.name || b.companyName || "",
      storeAddress: b.storeAddress || b.stores?.address || b.companyAddress || "",
      storePhone: b.storePhone || b.stores?.phone || b.companyPhone || "",
      customerId: b.customerid || b.customer_id || b.customerId || "",
      customerName: b.customerName || b.customers?.name || "",
      customerPhone: b.customerPhone || b.customers?.phone || "",
      customerEmail: b.customerEmail || b.customers?.email || "",
      customerAddress: b.customerAddress || b.customers?.address || "",
      userId: b.userid || b.user_id || b.userId || "",
      subtotal: b.subtotal ?? 0,
      taxPercentage: b.taxpercentage ?? b.tax_percentage ?? 0,
      taxAmount: b.taxamount ?? b.tax_amount ?? 0,
      cgst: b.cgst ?? 0,
      sgst: b.sgst ?? 0,
      discountPercentage: b.discountpercentage ?? b.discount_percentage ?? 0,
      discountAmount: b.discountamount ?? b.discount_amount ?? 0,
      total: b.total ?? 0,
      paymentMethod: b.paymentmethod || b.payment_method || b.paymentMethod || "Cash",
      timestamp: b.timestamp || b.created_at || new Date().toISOString(),
      status: b.status || "completed",
      createdBy: b.createdby || b.created_by || b.createdBy || "",
      createdAt: b.created_at || b.createdAt || new Date().toISOString(),
      updatedAt: b.updated_at || b.updatedAt || new Date().toISOString(),
      notes: b.notes || "",
      gstin: b.gstin || "",
      companyName: b.companyName || "",
      companyAddress: b.companyAddress || "",
      companyPhone: b.companyPhone || "",
      companyEmail: b.companyEmail || "",
      billFormat: b.billFormat || b.bill_format || "Thermal 80mm",
      items: b.items || [],
      canEdit: b.can_edit ?? b.canEdit ?? null,
      canCancel: b.can_cancel ?? b.canCancel ?? null,
      editExpiresAt: b.edit_expires_at || b.editExpiresAt || "",
      secondsRemaining: b.seconds_remaining ?? b.secondsRemaining ?? 0,
      cancelReason: b.cancel_reason || b.cancelReason || "",
    }))

    normalized.sort(
      (a: any, b: any) =>
        toEpochMs(b.timestamp) - toEpochMs(a.timestamp)
    )

    setInvoices(normalized)
    setFilteredInvoices(normalized)

    console.log(`✅ Loaded ${normalized.length} invoices from backend`)
    if (usedFallback) {
      toast({
        title: "Showing cached billing history",
        description: "Live billing history is temporarily unavailable. Trying again shortly.",
        variant: "default",
      })
    }
  } catch (error) {
    console.error("❌ Failed to fetch billing history:", error)
  }
  }, [currentStore])

  const loadHistoryPrinters = useCallback(async () => {
    if (!isTauriRuntime) return
    setIsLoadingHistoryPrinters(true)
    try {
      const printers = await listPrinters()
      setHistoryPrinters(printers)
      setHistorySelectedPrinter((prev) =>
        prev !== SYSTEM_DEFAULT_PRINTER_VALUE && prev && !printers.includes(prev)
          ? SYSTEM_DEFAULT_PRINTER_VALUE
          : prev,
      )
    } finally {
      setIsLoadingHistoryPrinters(false)
    }
  }, [isTauriRuntime])

  const fetchBillItems = useCallback(async (billId: string) => {
    try {
      const response = await apiClient(`/api/bills/${billId}/items`, { method: "GET" })
      if (!response.ok) {
        console.error(`Failed to fetch bill items for ${billId}:`, response.status)
        return []
      }
      const data = await response.json()
      return (data || []).map((item: any) => {
        const product = item.products || {}
        const hsnFromProduct = Array.isArray(product.hsn_codes)
          ? product.hsn_codes?.[0]?.hsn_code
          : product.hsn_codes?.hsn_code
        const hsnCode =
          item.hsn_code ||
          item.hsnCode ||
          product.hsn_code ||
          product.hsnCode ||
          hsnFromProduct ||
          ""
        const taxCandidates = [
          item.tax_percentage,
          item.taxPercentage,
          product.tax,
          Array.isArray(product.hsn_codes) ? product.hsn_codes?.[0]?.tax : product.hsn_codes?.tax,
        ]
        const resolvedTax = taxCandidates.reduce<number>((acc, value) => {
          if (acc > 0) return acc
          const parsed = Number(value || 0)
          return Number.isFinite(parsed) ? parsed : 0
        }, 0)
        return {
          id: item.id,
          productId: item.productid || item.product_id,
          name: product.name || item.name || "Unknown Item",
          quantity: item.quantity || 0,
          price: item.price || item.unit_price || 0,
          total: item.total || item.item_total || 0,
          barcodes: product.barcode || "",
          taxPercentage: resolvedTax,
          hsnCode,
        }
      })
    } catch (error) {
      console.error("Failed to fetch bill items:", error)
      return []
    }
  }, [])

  const fetchBillReplacements = useCallback(async (billId: string) => {
    try {
      const response = await apiClient(`/api/bills/${billId}/replacements`, { method: "GET" })
      if (!response.ok) return []
      const data = await response.json()
      return (data || []) as BillReplacement[]
    } catch (error) {
      console.error("Failed to fetch bill replacements:", error)
      return []
    }
  }, [])

  const enrichItemsWithReplacementMeta = useCallback((items: any[], replacements: BillReplacement[]) => {
    if (!replacements.length) return items

    const qtyByNewProductId = new Map<string, number>()
    replacements.forEach((replacement) => {
      const existing = qtyByNewProductId.get(replacement.new_product_id) || 0
      qtyByNewProductId.set(replacement.new_product_id, existing + Number(replacement.quantity || 0))
    })

    return items.map((item: any) => {
      const replacementQty = qtyByNewProductId.get(item.productId) || 0
      if (!replacementQty) return item
      return {
        ...item,
        replacementTag: `Replaced Qty: ${Math.max(0, Math.min(item.quantity || 0, replacementQty))}`,
      }
    })
  }, [])


  useEffect(() => {
    fetchBillingHistory()
    fetchSettings()

    // Refresh every 30 seconds
    const refreshInterval = setInterval(fetchBillingHistory, 30 * 1000)
    return () => clearInterval(refreshInterval)
  }, [fetchBillingHistory, fetchSettings])

  // ✅ Filter invoices with safe property access
  useEffect(() => {
    if (!searchTerm.trim()) {
      setFilteredInvoices(invoices)
      return
    }

    const searchLower = searchTerm.toLowerCase()

    const filtered = invoices.filter((invoice) => {
      // Safely access invoice ID
      const invoiceId = invoice.id?.toLowerCase() || ""

      // Get customer name and phone (handles both old and new formats)
      const customerName = getCustomerName(invoice)
      const customerNameLower = customerName.toLowerCase()
      const customerPhone = getCustomerPhone(invoice)
      const customerPhoneLower = customerPhone.toLowerCase()

      // Search in ID, customer name, and phone
      return (
        invoiceId.includes(searchLower) ||
        customerNameLower.includes(searchLower) ||
        customerPhoneLower.includes(searchLower)
      )
    })

    setFilteredInvoices(filtered)
  }, [searchTerm, invoices])

  const groupedInvoices = useMemo<DayInvoiceGroup[]>(() => {
    const map = new Map<string, Invoice[]>()
    filteredInvoices.forEach((invoice) => {
      const dateKey = getIstDateKey(invoice.timestamp || invoice.createdAt || "")
      if (!dateKey) return
      const list = map.get(dateKey) || []
      list.push(invoice)
      map.set(dateKey, list)
    })

    return Array.from(map.entries())
      .map(([dateKey, dayInvoices]) => {
        const sortedInvoices = [...dayInvoices].sort(
          (a, b) =>
            toEpochMs(b.timestamp || b.createdAt || "") -
            toEpochMs(a.timestamp || a.createdAt || ""),
        )
        const totalBills = sortedInvoices.length
        const totalValue = sortedInvoices.reduce((acc, invoice) => {
          const status = String(invoice.status || "").toLowerCase()
          if (status !== "completed" && status !== "paid") {
            return acc
          }
          return acc + Number(invoice.total || 0)
        }, 0)
        return { dateKey, invoices: sortedInvoices, totalBills, totalValue }
      })
      .sort((a, b) => b.dateKey.localeCompare(a.dateKey))
  }, [filteredInvoices])

  useEffect(() => {
    if (!groupedInvoices.length) {
      setOpenDayKeys([])
      return
    }

    if (searchTerm.trim()) {
      setOpenDayKeys(groupedInvoices.map((group) => group.dateKey))
      return
    }

    const todayKey = getTodayIstDateKey()
    if (groupedInvoices.some((group) => group.dateKey === todayKey)) {
      setOpenDayKeys([todayKey])
      return
    }

    setOpenDayKeys([])
  }, [groupedInvoices, searchTerm])

  const handleViewInvoice = async (invoice: Invoice) => {
    const [items, replacements] = await Promise.all([
      fetchBillItems(invoice.id),
      fetchBillReplacements(invoice.id),
    ])
    const enrichedItems = enrichItemsWithReplacementMeta(items, replacements)
    setSelectedInvoice({
      ...invoice,
      items: enrichedItems,
      isReplacementBill: replacements.length > 0,
      companyName: settings?.companyName || invoice.companyName || "",
      companyAddress: settings?.companyAddress || invoice.companyAddress || "",
      companyPhone: settings?.companyPhone || invoice.companyPhone || "",
      companyEmail: settings?.companyEmail || invoice.companyEmail || "",
      gstin: settings?.gstin || invoice.gstin || "",
    } as Invoice)
    setShowPreview(true)
  }

  const handlePrintInvoice = async (invoice: Invoice) => {
    if (printingInvoiceId) return
    setPrintingInvoiceId(invoice.id)
    try {
      const [items, replacements] = await Promise.all([
        fetchBillItems(invoice.id),
        fetchBillReplacements(invoice.id),
      ])
      const enrichedItems = enrichItemsWithReplacementMeta(items, replacements)
      const printable = {
        ...invoice,
        items: enrichedItems,
        isReplacementBill: replacements.length > 0,
        companyName: settings?.companyName || invoice.companyName || "",
        companyAddress: settings?.companyAddress || invoice.companyAddress || "",
        companyPhone: settings?.companyPhone || invoice.companyPhone || "",
        companyEmail: settings?.companyEmail || invoice.companyEmail || "",
        gstin: settings?.gstin || invoice.gstin || "",
      } as Invoice

      setHistoryPrintInvoice(printable)
      setHistoryPrintCopies(1)
      setShowPrintDialog(true)
      await loadHistoryPrinters()
    } catch (error) {
      console.error("❌ [BillingHistory] Failed to prepare print preview:", error)
      toast({
        title: "Print Preview Failed",
        description: "Could not prepare invoice preview for printing.",
        variant: "destructive",
      })
    } finally {
      setPrintingInvoiceId(null)
    }
  }

  const handleConfirmHistoryPrint = async () => {
    if (!historyPrintInvoice) return
    setIsHistoryPrinting(true)
    try {
      await new Promise((resolve) => setTimeout(resolve, 0))
      const printOuter = printRef.current?.outerHTML || ""
      if (!printOuter) {
        throw new Error("Print content is not ready yet")
      }

      const printContent = generatePrintHTML(printOuter, printPaperSize, historyPrintInvoice.id || "invoice")
      const copies = Math.max(1, Math.trunc(Number(historyPrintCopies || 1)))

      if (isTauriRuntime) {
        const printerName = historySelectedPrinter === SYSTEM_DEFAULT_PRINTER_VALUE ? "" : historySelectedPrinter
        const result = await printHtmlContent(printContent, {
          paperSize: printPaperSize,
          printerName,
          copies,
        })
        console.log("✅ [BillingHistory] Tauri print submitted:", result)
        toast({
          title: "Print job queued",
          description: `Printer: ${printerName || "System default"} • Copies: ${copies}`,
          variant: "default",
        })
      } else {
        const result = await safePrint(printContent, printPaperSize)
        if (!result.success) {
          throw new Error(result.error || "Browser print failed")
        }
      }

      setShowPrintDialog(false)
    } catch (error) {
      console.error("❌ [BillingHistory] Print failed:", error)
      toast({
        title: "Print Failed",
        description: error instanceof Error ? error.message : "Could not print invoice.",
        variant: "destructive",
      })
    } finally {
      setIsHistoryPrinting(false)
    }
  }

  const generatePrintHTML = (printContent: string, paperSize: string, invoiceId: string): string => {
    const getPageStyles = (): string => {
      if (paperSize === "Thermal 58mm") {
        return `
          @page { size: 58mm auto; margin: 0; }
          html, body {
            width: 100%;
            margin: 0;
            padding: 0;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
          body { display: block; }
          .print-container {
            width: 100% !important;
            max-width: 50mm !important;
            margin: 0 auto !important;
            padding-left: 3px !important;
            padding-right: 2px !important;
            box-sizing: border-box !important;
          }
        `
      } else if (paperSize === "Thermal 80mm") {
        return `
          @page { size: 80mm auto; margin: 0; }
          html, body {
            width: 100%;
            margin: 0;
            padding: 0;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
          body { display: block; }
          .print-container {
            width: 100% !important;
            max-width: 72mm !important;
            margin: 0 auto !important;
            padding-left: 5px !important;
            padding-right: 2px !important;
            box-sizing: border-box !important;
          }
        `
      } else if (paperSize === "A4") {
        return `
          @page { size: A4 portrait; margin: 5mm 8mm 8mm 8mm; }
          body { margin: 0; padding: 0; }
        `
      } else if (paperSize === "Letter") {
        return `
          @page { size: Letter portrait; margin: 0.2in 0.25in 0.25in 0.25in; }
          body { margin: 0; padding: 0; }
        `
      }
      return `
        @page { size: A4 portrait; margin: 5mm 8mm 8mm 8mm; }
        body { margin: 0; padding: 0; }
      `
    }

    return `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Invoice-${invoiceId}</title>
          <style>
            ${getPageStyles()}
            * {
              box-sizing: border-box;
              margin: 0;
              padding: 0;
            }
            html, body {
              font-family: "Courier New", monospace;
              font-size: ${paperSize.includes("Thermal") ? "12px" : "14px"};
              line-height: 1.5;
              -webkit-print-color-adjust: exact;
              print-color-adjust: exact;
              background: white;
              color: black;
              height: auto;
            }
            @media print {
              html, body {
                margin: 0 !important;
                overflow: visible !important;
                height: auto !important;
              }
              @page { margin: 0; }
            }
            .print-container {
              width: 100%;
              max-width: 100%;
              padding: 0;
              margin: 0 auto;
              box-sizing: border-box;
            }

          .invoice-wrapper {
            break-after: avoid-page;
            page-break-after: avoid;
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
  }

  const getPrintableDayInvoices = (group: DayInvoiceGroup): Invoice[] =>
    group.invoices.filter((invoice) => {
      const status = String(invoice.status || "").toLowerCase()
      return status === "completed" || status === "paid"
    })

  const formatCurrency = (value: number) => `₹${Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`

  const buildDayReportData = (group: DayInvoiceGroup) => {
    const printableInvoices = getPrintableDayInvoices(group)
    const totalBills = printableInvoices.length
    const totalAmount = printableInvoices.reduce((sum, invoice) => sum + Number(invoice.total || 0), 0)
    const totalDiscountAmount = printableInvoices.reduce((sum, invoice) => sum + Number(invoice.discountAmount || 0), 0)
    const totalSubtotal = printableInvoices.reduce((sum, invoice) => sum + Number(invoice.subtotal || 0), 0)
    const effectiveDiscountPercentage = totalSubtotal > 0 ? (totalDiscountAmount / totalSubtotal) * 100 : 0

    return {
      companyName: settings?.companyName || currentStore?.name || "Company",
      reportTitle: `${formatIstDateKey(group.dateKey)} Billing Report`,
      rows: printableInvoices.map((invoice) => ({
        id: invoice.id,
        amount: Number(invoice.total || 0),
      })),
      totalBills,
      totalAmount,
      totalDiscountAmount,
      effectiveDiscountPercentage,
    }
  }

  const escapeHtml = (value: string) =>
    String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")

  const generateDailyReportHTML = (group: DayInvoiceGroup, paperSize: string = "Thermal 80mm"): string => {
    const report = buildDayReportData(group)
    const printableInvoices = getPrintableDayInvoices(group)

    const isThermal = paperSize === "Thermal 80mm" || paperSize === "Thermal 58mm"
    const is58mm = paperSize === "Thermal 58mm"
    const thermalWidth = is58mm ? "58mm" : "80mm"
    const thermalContent = is58mm ? "52mm" : "72mm"
    const baseFontSize = is58mm ? 11 : 13
    const headerFontSize = is58mm ? 14 : 16
    const totalFontSize = is58mm ? 13 : 14

    const paymentBreakdown = new Map<string, { count: number; amount: number }>()
    printableInvoices.forEach((invoice) => {
      const method = invoice.paymentMethod || "Cash"
      const existing = paymentBreakdown.get(method) || { count: 0, amount: 0 }
      paymentBreakdown.set(method, {
        count: existing.count + 1,
        amount: existing.amount + Number(invoice.total || 0),
      })
    })

    const now = new Date()
    const printedAt = new Intl.DateTimeFormat("en-IN", {
      timeZone: IST_TIMEZONE,
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    }).format(now)

    const storePhone = printableInvoices[0] ? getStorePhone(printableInvoices[0]) : ""
    const storeAddress = printableInvoices[0] ? getStoreAddress(printableInvoices[0]) : ""

    const paymentRows = Array.from(paymentBreakdown.entries())
      .map(
        ([method, data]) => `
      <tr>
        <td style="padding:2px 0;font-size:${baseFontSize}px;">${escapeHtml(method)} (${data.count})</td>
        <td style="padding:2px 0;font-size:${baseFontSize}px;text-align:right;font-weight:600;">Rs.${escapeHtml(
          data.amount.toLocaleString("en-IN", { maximumFractionDigits: 2 }),
        )}</td>
      </tr>`,
      )
      .join("")

    if (isThermal) {
      const tableRows = printableInvoices
        .map((invoice, idx) => {
          const time = (() => {
            const d = parseServerDate(invoice.timestamp || invoice.createdAt || "")
            if (!d) return "-"
            return new Intl.DateTimeFormat("en-IN", {
              timeZone: IST_TIMEZONE,
              hour: "2-digit",
              minute: "2-digit",
              hour12: true,
            }).format(d)
          })()
          const customer = getCustomerName(invoice) || "Walk-in"
          const payment = invoice.paymentMethod || "Cash"
          const discount = Number(invoice.discountAmount || 0)
          const amount = Number(invoice.total || 0)
          return `
        <tr>
          <td style="padding:3px 2px;border-bottom:1px dashed #ccc;font-size:${baseFontSize}px;">${idx + 1}. ${escapeHtml(
            invoice.id,
          )}</td>
          <td style="padding:3px 2px;border-bottom:1px dashed #ccc;font-size:${baseFontSize}px;text-align:right;font-weight:600;">Rs.${escapeHtml(
            amount.toLocaleString("en-IN", { maximumFractionDigits: 2 }),
          )}</td>
        </tr>
        <tr>
          <td colspan="2" style="padding:0 2px 5px 2px;font-size:${baseFontSize - 1}px;color:#555;">
            ${escapeHtml(customer)} | ${escapeHtml(time)} | ${escapeHtml(payment)}${
              discount > 0
                ? ` | Disc: Rs.${discount.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`
                : ""
            }
          </td>
        </tr>`
        })
        .join("")

      return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>${escapeHtml(report.reportTitle)}</title>
  <style>
    @page { size: ${thermalWidth} auto; margin: 0; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: ${thermalWidth}; margin: 0; padding: 0; font-family: 'Courier New', monospace; font-size: ${baseFontSize}px; color: #000; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .wrap { width: ${thermalContent}; margin: 0 auto; padding: 4mm 0 6mm 0; }
    table { width: 100%; border-collapse: collapse; }
    .divider-solid { border: none; border-top: 1.5px solid #000; margin: 5px 0; }
    .divider-dashed { border: none; border-top: 1px dashed #999; margin: 4px 0; }
  </style>
</head>
<body>
<div class="wrap">
  <div style="text-align:center;margin-bottom:5px;">
    <div style="font-size:${headerFontSize}px;font-weight:700;letter-spacing:0.5px;">${escapeHtml(
      report.companyName,
    )}</div>
    ${storeAddress ? `<div style="font-size:${baseFontSize - 1}px;">${escapeHtml(storeAddress)}</div>` : ""}
    ${storePhone ? `<div style="font-size:${baseFontSize - 1}px;">Ph: ${escapeHtml(storePhone)}</div>` : ""}
  </div>
  <hr class="divider-solid"/>
  <div style="text-align:center;font-size:${baseFontSize + 1}px;font-weight:700;margin:3px 0;">DAILY BILLING REPORT</div>
  <div style="text-align:center;font-size:${baseFontSize}px;margin-bottom:2px;">${escapeHtml(
    formatIstDateKey(group.dateKey),
  )}</div>
  <div style="text-align:center;font-size:${baseFontSize - 2}px;color:#555;margin-bottom:3px;">Printed: ${escapeHtml(
    printedAt,
  )}</div>
  <hr class="divider-solid"/>
  <table><tbody>
    ${tableRows || `<tr><td colspan="2" style="text-align:center;padding:6px;font-size:${baseFontSize}px;">No completed bills.</td></tr>`}
  </tbody></table>
  <hr class="divider-solid"/>
  <div style="font-size:${baseFontSize}px;font-weight:700;margin-bottom:3px;">PAYMENT BREAKDOWN</div>
  <table><tbody>${paymentRows}</tbody></table>
  <hr class="divider-dashed"/>
  <table><tbody>
    <tr>
      <td style="font-size:${baseFontSize}px;padding:2px 0;">Total bills</td>
      <td style="font-size:${baseFontSize}px;padding:2px 0;text-align:right;font-weight:700;">${escapeHtml(
        String(report.totalBills),
      )}</td>
    </tr>
    <tr>
      <td style="font-size:${baseFontSize}px;padding:2px 0;">Discount (${escapeHtml(
        report.effectiveDiscountPercentage.toFixed(2),
      )}%)</td>
      <td style="font-size:${baseFontSize}px;padding:2px 0;text-align:right;">Rs.${escapeHtml(
        report.totalDiscountAmount.toLocaleString("en-IN", { maximumFractionDigits: 2 }),
      )}</td>
    </tr>
  </tbody></table>
  <hr class="divider-solid"/>
  <table><tbody>
    <tr>
      <td style="font-size:${totalFontSize}px;font-weight:700;padding:2px 0;">TOTAL AMOUNT</td>
      <td style="font-size:${totalFontSize}px;font-weight:700;padding:2px 0;text-align:right;">Rs.${escapeHtml(
        report.totalAmount.toLocaleString("en-IN", { maximumFractionDigits: 2 }),
      )}</td>
    </tr>
  </tbody></table>
  <hr class="divider-solid"/>
  <div style="text-align:center;font-size:${baseFontSize - 1}px;color:#555;margin-top:6px;">*** End of Report ***</div>
</div>
</body>
</html>`
    }

    const isLetter = paperSize === "Letter"
    const pageSize = isLetter ? "Letter portrait" : "A4 portrait"
    const pageMargin = isLetter ? "0.5in 0.6in 0.6in 0.6in" : "12mm 14mm 14mm 14mm"

    const tableRows = printableInvoices
      .map((invoice, idx) => {
        const time = (() => {
          const d = parseServerDate(invoice.timestamp || invoice.createdAt || "")
          if (!d) return "-"
          return new Intl.DateTimeFormat("en-IN", {
            timeZone: IST_TIMEZONE,
            hour: "2-digit",
            minute: "2-digit",
            hour12: true,
          }).format(d)
        })()
        const customer = getCustomerName(invoice) || "Walk-in Customer"
        const payment = invoice.paymentMethod || "Cash"
        const discount = Number(invoice.discountAmount || 0)
        const amount = Number(invoice.total || 0)
        const bg = idx % 2 === 1 ? "background:#fafafa;" : ""
        return `
      <tr style="${bg}">
        <td style="border:1px solid #ddd;padding:8px 10px;text-align:center;color:#888;font-size:13px;">${idx + 1}</td>
        <td style="border:1px solid #ddd;padding:8px 10px;font-size:13px;">${escapeHtml(invoice.id)}</td>
        <td style="border:1px solid #ddd;padding:8px 10px;font-size:14px;">${escapeHtml(customer)}</td>
        <td style="border:1px solid #ddd;padding:8px 10px;font-size:13px;color:#555;">${escapeHtml(time)}</td>
        <td style="border:1px solid #ddd;padding:8px 10px;text-align:center;font-size:13px;">${escapeHtml(payment)}</td>
        <td style="border:1px solid #ddd;padding:8px 10px;text-align:right;font-size:13px;color:#666;">Rs.${escapeHtml(
          discount.toLocaleString("en-IN", { maximumFractionDigits: 2 }),
        )}</td>
        <td style="border:1px solid #ddd;padding:8px 10px;text-align:right;font-size:14px;font-weight:600;">Rs.${escapeHtml(
          amount.toLocaleString("en-IN", { maximumFractionDigits: 2 }),
        )}</td>
      </tr>`
      })
      .join("")

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>${escapeHtml(report.reportTitle)}</title>
  <style>
    @page { size: ${pageSize}; margin: ${pageMargin}; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; color: #111; font-size: 14px; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #f1f5f9; border: 1px solid #ccc; padding: 9px 10px; font-size: 13px; text-align: left; }
    .two-col { display: flex; gap: 16px; margin-top: 16px; }
    .box { flex: 1; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 12px 16px; }
    .box-title { font-size: 12px; color: #666; margin-bottom: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
  </style>
</head>
<body>
  <div style="text-align:center;margin-bottom:6px;">
    <div style="font-size:22px;font-weight:700;">${escapeHtml(report.companyName)}</div>
    ${storeAddress ? `<div style="font-size:13px;color:#555;">${escapeHtml(storeAddress)}${storePhone ? " | Ph: " + escapeHtml(storePhone) : ""}</div>` : ""}
    <div style="font-size:16px;font-weight:600;margin-top:8px;">${escapeHtml(
      formatIstDateKey(group.dateKey),
    )} ? Daily Billing Report</div>
    <div style="font-size:12px;color:#888;margin-top:3px;">Printed: ${escapeHtml(printedAt)}</div>
  </div>
  <div style="border-top:2px solid #111;border-bottom:1px solid #ccc;margin:10px 0;"></div>
  <table>
    <thead>
      <tr>
        <th style="width:36px;text-align:center;">#</th>
        <th>Invoice ID</th>
        <th>Customer</th>
        <th style="width:80px;">Time</th>
        <th style="width:70px;text-align:center;">Payment</th>
        <th style="text-align:right;">Discount</th>
        <th style="text-align:right;">Amount</th>
      </tr>
    </thead>
    <tbody>
      ${tableRows || `<tr><td colspan="7" style="text-align:center;padding:14px;border:1px solid #ddd;color:#888;">No completed bills.</td></tr>`}
    </tbody>
  </table>
  <div style="border-top:1px solid #ccc;margin-top:0;"></div>
  <div class="two-col">
    <div class="box">
      <div class="box-title">Payment Breakdown</div>
      <table style="border:none;">
        <tbody>
          ${Array.from(paymentBreakdown.entries())
            .map(
              ([method, data]) => `
            <tr>
              <td style="padding:4px 0;font-size:13px;">${escapeHtml(method)}</td>
              <td style="padding:4px 0;font-size:13px;text-align:center;color:#666;">${data.count} bill${
                data.count !== 1 ? "s" : ""
              }</td>
              <td style="padding:4px 0;font-size:13px;text-align:right;font-weight:600;">Rs.${escapeHtml(
                data.amount.toLocaleString("en-IN", { maximumFractionDigits: 2 }),
              )}</td>
            </tr>`,
            )
            .join("")}
        </tbody>
      </table>
    </div>
    <div class="box">
      <div class="box-title">Summary</div>
      <table style="border:none;">
        <tbody>
          <tr><td style="padding:4px 0;font-size:13px;">Total bills</td><td style="padding:4px 0;font-size:13px;text-align:right;font-weight:600;">${escapeHtml(
            String(report.totalBills),
          )}</td></tr>
          <tr><td style="padding:4px 0;font-size:13px;">Discount (${escapeHtml(
            report.effectiveDiscountPercentage.toFixed(2),
          )}%)</td><td style="padding:4px 0;font-size:13px;text-align:right;">Rs.${escapeHtml(
            report.totalDiscountAmount.toLocaleString("en-IN", { maximumFractionDigits: 2 }),
          )}</td></tr>
          <tr style="border-top:1px solid #ddd;">
            <td style="padding:6px 0 4px;font-size:15px;font-weight:700;">Total Amount</td>
            <td style="padding:6px 0 4px;font-size:15px;font-weight:700;text-align:right;">Rs.${escapeHtml(
              report.totalAmount.toLocaleString("en-IN", { maximumFractionDigits: 2 }),
            )}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
  <div style="text-align:center;margin-top:16px;font-size:12px;color:#aaa;border-top:1px dashed #ddd;padding-top:10px;">? End of Report ?</div>
</body>
</html>`
  }


const handleOpenDayReportDialog = async (group: DayInvoiceGroup, event?: MouseEvent) => {
    event?.preventDefault()
    event?.stopPropagation()
    setSelectedDayReport(group)
    setDailyReportCopies(1)
    setShowDailyReportDialog(true)
    await loadHistoryPrinters()
  }

  const handleConfirmDailyReportPrint = async () => {
    if (!selectedDayReport) return
    setIsDailyReportPrinting(true)
    try {
      const reportHtml = generateDailyReportHTML(selectedDayReport, historySelectedPaperSize)
      const copies = Math.max(1, Math.trunc(Number(dailyReportCopies || 1)))
      if (isTauriRuntime) {
        const printerName = historySelectedPrinter === SYSTEM_DEFAULT_PRINTER_VALUE ? "" : historySelectedPrinter
        await printHtmlContent(reportHtml, {
          paperSize: historySelectedPaperSize,
          printerName,
          copies,
        })
        toast({
          title: "Report print queued",
          description: `Printer: ${printerName || "System default"} • Copies: ${copies}`,
          variant: "default",
        })
      } else {
        const result = await safePrint(reportHtml, historySelectedPaperSize)
        if (!result.success) throw new Error(result.error || "Browser print failed")
      }
      setShowDailyReportDialog(false)
    } catch (error) {
      console.error("❌ [BillingHistory] Day report print failed:", error)
      toast({
        title: "Print Failed",
        description: error instanceof Error ? error.message : "Could not print billing report.",
        variant: "destructive",
      })
    } finally {
      setIsDailyReportPrinting(false)
    }
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case "completed":
      case "paid":
        return "bg-green-100 text-green-800"
      case "pending":
        return "bg-yellow-100 text-yellow-800"
      case "cancelled":
      case "overdue":
        return "bg-red-100 text-red-800"
      default:
        return "bg-gray-100 text-gray-800"
    }
  }

  const getSecondsRemaining = (invoice: Invoice): number => {
    if (typeof invoice.secondsRemaining === "number" && invoice.secondsRemaining >= 0) {
      if (!invoice.editExpiresAt) return invoice.secondsRemaining
      const expiresMs = new Date(invoice.editExpiresAt).getTime()
      if (Number.isNaN(expiresMs)) return invoice.secondsRemaining
      return Math.max(0, Math.floor((expiresMs - clockNowMs) / 1000))
    }
    if (!invoice.editExpiresAt) return 0
    const expiresMs = new Date(invoice.editExpiresAt).getTime()
    if (Number.isNaN(expiresMs)) return 0
    return Math.max(0, Math.floor((expiresMs - clockNowMs) / 1000))
  }

  const canEditInvoice = (invoice: Invoice) => {
    if (typeof invoice.canEdit === "boolean") {
      return invoice.canEdit && getSecondsRemaining(invoice) > 0
    }
    const status = String(invoice.status || "").toLowerCase()
    if (!["completed", "paid", "pending"].includes(status)) return false
    const createdAtMs = new Date(invoice.createdAt || invoice.timestamp).getTime()
    if (Number.isNaN(createdAtMs)) return false
    return createdAtMs + 24 * 60 * 60 * 1000 > clockNowMs
  }

  const formatRemaining = (totalSeconds: number): string => {
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const seconds = totalSeconds % 60
    if (hours > 0) return `${hours}h ${minutes}m`
    if (minutes > 0) return `${minutes}m ${seconds}s`
    return `${seconds}s`
  }

  const isInvoiceEdited = (invoice: Invoice): boolean => {
    const status = String(invoice.status || "").toLowerCase()
    if (status === "cancelled") return false
    const createdMs = new Date(invoice.createdAt || invoice.timestamp).getTime()
    const updatedMs = new Date(invoice.updatedAt || "").getTime()
    if (Number.isNaN(createdMs) || Number.isNaN(updatedMs)) return false
    return updatedMs - createdMs > 1000
  }

  const handleEditInvoice = (invoice: Invoice) => {
    const secondsRemaining = getSecondsRemaining(invoice)
    if (!canEditInvoice(invoice) || secondsRemaining <= 0) {
      toast({
        title: "Edit window closed",
        description: "This invoice is no longer editable.",
        variant: "destructive",
      })
      return
    }

    if (typeof window !== "undefined") {
      const payload = {
        billId: invoice.id,
        editExpiresAt: invoice.editExpiresAt || null,
        startedAt: new Date().toISOString(),
      }
      window.sessionStorage.setItem("invoice-edit-session", JSON.stringify(payload))
      window.dispatchEvent(new CustomEvent("start-invoice-edit-session"))
    }

    onEditInvoice?.(invoice.id)
  }

  const handleOpenAudit = async (invoice: Invoice) => {
    setAuditInvoiceId(invoice.id)
    setShowAuditDialog(true)
    setIsAuditLoading(true)
    setAuditSearchTerm("")
    setAuditTypeFilter("all")
    setAuditPage(1)
    setAuditHasMore(false)
    setAuditNextOffset(0)
    try {
      const response = await apiClient(
        `/api/bills/${invoice.id}/events?limit=${auditFetchLimit}&offset=0`,
        { method: "GET" },
      )
      if (!response.ok) {
        setAuditEvents([])
        return
      }
      const data = await response.json()
      if (Array.isArray(data)) {
        setAuditEvents(data)
        setAuditHasMore(false)
        setAuditNextOffset(data.length)
      } else {
        const events = Array.isArray(data?.events) ? data.events : []
        setAuditEvents(events)
        setAuditHasMore(Boolean(data?.has_more))
        setAuditNextOffset(Number(data?.next_offset || events.length || 0))
      }
    } catch (error) {
      console.error("Failed to fetch bill audit events:", error)
      setAuditEvents([])
    } finally {
      setIsAuditLoading(false)
    }
  }

  const handleLoadMoreAudit = async () => {
    if (!auditInvoiceId || !auditHasMore || isAuditLoadingMore) return
    setIsAuditLoadingMore(true)
    try {
      const response = await apiClient(
        `/api/bills/${auditInvoiceId}/events?limit=${auditFetchLimit}&offset=${auditNextOffset}`,
        { method: "GET" },
      )
      if (!response.ok) return
      const data = await response.json()
      const events = Array.isArray(data?.events) ? data.events : []
      setAuditEvents((prev) => [...prev, ...events])
      setAuditHasMore(Boolean(data?.has_more))
      setAuditNextOffset(Number(data?.next_offset || (auditNextOffset + events.length)))
    } catch (error) {
      console.error("Failed to load more audit events:", error)
    } finally {
      setIsAuditLoadingMore(false)
    }
  }

  const getAuditTypeLabel = (type: string) => {
    if (type === "invoice_revised") return "Revised"
    if (type === "invoice_cancelled") return "Cancelled"
    return type
  }

  const getAuditTypeClass = (type: string) => {
    if (type === "invoice_revised") return "bg-blue-100 text-blue-800"
    if (type === "invoice_cancelled") return "bg-red-100 text-red-800"
    return "bg-gray-100 text-gray-800"
  }

  const filteredAuditEvents = auditEvents.filter((event) => {
    const matchesType = auditTypeFilter === "all" || event.type === auditTypeFilter
    if (!matchesType) return false
    if (!auditSearchTerm.trim()) return true
    const q = auditSearchTerm.toLowerCase()
    return (
      String(event.notification || "").toLowerCase().includes(q) ||
      String(event.type || "").toLowerCase().includes(q)
    )
  })

  useEffect(() => {
    setAuditPage(1)
  }, [auditSearchTerm, auditTypeFilter])

  const totalAuditPages = Math.max(1, Math.ceil(filteredAuditEvents.length / auditPageSize))
  const currentAuditPage = Math.min(auditPage, totalAuditPages)
  const pagedAuditEvents = filteredAuditEvents.slice(
    (currentAuditPage - 1) * auditPageSize,
    currentAuditPage * auditPageSize,
  )

  const exportAuditCsv = () => {
    if (!filteredAuditEvents.length) {
      toast({
        title: "No audit data",
        description: "There are no audit events to export for current filters.",
        variant: "destructive",
      })
      return
    }

    const escapeCsv = (value: string) => `"${String(value ?? "").replace(/"/g, '""')}"`
    const header = ["invoice_id", "event_type", "event_label", "message", "created_at_iso", "created_at_local"]
    const rows = filteredAuditEvents.map((event) => [
      auditInvoiceId,
      event.type,
      getAuditTypeLabel(event.type),
      event.notification || "",
      event.created_at || "",
      formatIstDateTime(event.created_at || ""),
    ])
    const csv = [header, ...rows].map((row) => row.map((cell) => escapeCsv(String(cell))).join(",")).join("\n")

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
    const url = window.URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `invoice-audit-${auditInvoiceId}.csv`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    window.URL.revokeObjectURL(url)
  }

  if (!currentStore) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-center text-muted-foreground">
            Please select a store to view billing history
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Billing History</CardTitle>
          <CardDescription>View and manage all invoices for {currentStore.name}</CardDescription>
          <div className="flex items-center space-x-2 mt-4">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 h-4 w-4" />
              <Input
                placeholder="Search by invoice ID, customer name, or phone..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
              />
            </div>
            <Button onClick={fetchBillingHistory}>Refresh Data</Button>
          </div>
        </CardHeader>
        <CardContent>
          {filteredInvoices.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-muted-foreground">
                {searchTerm ? "No invoices found matching your search" : "No invoices yet"}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {groupedInvoices.map((group) => {
                const isOpen = openDayKeys.includes(group.dateKey)
                return (
                  <details
                    key={group.dateKey}
                    open={isOpen}
                    onToggle={(event) => {
                      const nextOpen = (event.currentTarget as HTMLDetailsElement).open
                      setOpenDayKeys((prev) => {
                        if (nextOpen) {
                          if (prev.includes(group.dateKey)) return prev
                          return [...prev, group.dateKey]
                        }
                        return prev.filter((key) => key !== group.dateKey)
                      })
                    }}
                    className="border rounded-md bg-slate-50/40"
                  >
                    <summary className="list-none cursor-pointer px-4 py-3 flex items-center justify-between gap-4">
                      <span className="font-medium text-sm">{formatIstDateKey(group.dateKey)}</span>
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-muted-foreground">
                          Total Bills: {group.totalBills} • Total Value: ₹{group.totalValue.toLocaleString()}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={(event) => handleOpenDayReportDialog(group, event)}
                        >
                          <Printer className="h-4 w-4 mr-1" />
                          Print
                        </Button>
                      </div>
                    </summary>
                    <div className="px-3 pb-3">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Invoice ID</TableHead>
                            <TableHead>Customer</TableHead>
                            <TableHead>Date</TableHead>
                            <TableHead>Total</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {group.invoices.map((invoice) => (
                            <TableRow key={invoice.id}>
                              <TableCell className="font-medium">{invoice.id}</TableCell>
                              <TableCell>
                                <div>
                                  <p className="font-medium">{getCustomerName(invoice)}</p>
                                  {getCustomerPhone(invoice) && (
                                    <p className="text-sm text-muted-foreground">
                                      {getCustomerPhone(invoice)}
                                    </p>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell>{formatIstDateTime(invoice.timestamp || invoice.createdAt || "")}</TableCell>
                              <TableCell>₹{Number(invoice.total || 0).toLocaleString()}</TableCell>
                              <TableCell>
                                <div className="flex flex-col gap-1">
                                  <Badge className={getStatusColor(invoice.status || "completed")}>
                                    {invoice.status || "Completed"}
                                  </Badge>
                                  {isInvoiceEdited(invoice) && (
                                    <span className="text-xs text-blue-700">Edited</span>
                                  )}
                                  {String(invoice.status || "").toLowerCase() === "cancelled" && invoice.cancelReason && (
                                    <span className="text-xs text-red-700">Reason: {invoice.cancelReason}</span>
                                  )}
                                  {canEditInvoice(invoice) && getSecondsRemaining(invoice) > 0 && (
                                    <span className="text-xs text-muted-foreground">
                                      Editable for {formatRemaining(getSecondsRemaining(invoice))}
                                    </span>
                                  )}
                                </div>
                              </TableCell>
                              <TableCell>
                                <div className="flex space-x-2">
                                  {canEditInvoice(invoice) && (
                                    <Button variant="outline" size="sm" onClick={() => handleEditInvoice(invoice)}>
                                      <Pencil className="h-4 w-4 mr-1" />
                                      Edit
                                    </Button>
                                  )}
                                  <Button variant="outline" size="sm" onClick={() => handleViewInvoice(invoice)}>
                                    <Eye className="h-4 w-4 mr-1" />
                                    View
                                  </Button>
                                  <Button variant="outline" size="sm" onClick={() => handleOpenAudit(invoice)}>
                                    <History className="h-4 w-4 mr-1" />
                                    Audit
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => handlePrintInvoice(invoice)}
                                    disabled={printingInvoiceId === invoice.id}
                                    className={printingInvoiceId === invoice.id ? "animate-pulse" : ""}
                                  >
                                    {printingInvoiceId === invoice.id ? (
                                      <>
                                        <span className="mr-1 inline-flex items-center">
                                          <span className="h-3 w-3 animate-spin rounded-full border-2 border-gray-500 border-t-transparent"></span>
                                        </span>
                                        Printing...
                                      </>
                                    ) : (
                                      <>
                                        <Printer className="h-4 w-4 mr-1" />
                                        Print
                                      </>
                                    )}
                                  </Button>
                                </div>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </details>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={showPreview} onOpenChange={setShowPreview}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>View Invoice</DialogTitle>
            <DialogDescription>
              {selectedInvoice ? `Invoice: ${selectedInvoice.id}` : "Invoice details"}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[75vh] overflow-y-auto rounded border bg-muted/20 p-2">
            {selectedInvoice ? (
              <PrintableInvoice invoice={selectedInvoice} paperSize={printPaperSize} />
            ) : (
              <p className="text-sm text-muted-foreground">No invoice selected.</p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Printable invoice directly used for billing-history printing */}
      <div className="hidden print:block">
        {historyPrintInvoice && (
          <PrintableInvoice ref={printRef} invoice={historyPrintInvoice} paperSize={printPaperSize} />
        )}
      </div>

      <Dialog open={showPrintDialog} onOpenChange={setShowPrintDialog}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Print Invoice</DialogTitle>
            <DialogDescription>
              {historyPrintInvoice ? `Invoice: ${historyPrintInvoice.id}` : "Select print options and confirm."}
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-3 md:border-r md:pr-4">
              <div className="space-y-2">
                <Label htmlFor="history-print-copies">No. of Copies</Label>
                <Input
                  id="history-print-copies"
                  type="number"
                  min={1}
                  step={1}
                  value={historyPrintCopies}
                  onChange={(e) => {
                    const value = Number(e.target.value)
                    setHistoryPrintCopies(Number.isFinite(value) && value > 0 ? Math.trunc(value) : 1)
                  }}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="history-printer-select">Printer</Label>
                {isTauriRuntime ? (
                  <Select
                    value={historySelectedPrinter}
                    onValueChange={setHistorySelectedPrinter}
                    disabled={isLoadingHistoryPrinters}
                  >
                    <SelectTrigger id="history-printer-select">
                      <SelectValue placeholder={isLoadingHistoryPrinters ? "Loading printers..." : "Select printer"} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={SYSTEM_DEFAULT_PRINTER_VALUE}>System Default</SelectItem>
                      {historyPrinters.map((printer) => (
                        <SelectItem key={printer} value={printer}>
                          {printer}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input id="history-printer-select" value="Browser Print Dialog" disabled />
                )}
              </div>

              {isTauriRuntime && historyPrinters.length === 0 && !isLoadingHistoryPrinters && (
                <p className="text-xs text-muted-foreground">No printers reported by Tauri. System default will be used.</p>
              )}
            </div>

            <div className="md:col-span-2 max-h-[70vh] overflow-y-auto rounded border bg-muted/20 p-2">
              {historyPrintInvoice ? (
                <PrintableInvoice invoice={historyPrintInvoice} paperSize={printPaperSize} />
              ) : (
                <p className="text-sm text-muted-foreground">No invoice selected for preview.</p>
              )}
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowPrintDialog(false)} disabled={isHistoryPrinting}>
              Cancel
            </Button>
            <Button onClick={handleConfirmHistoryPrint} disabled={!historyPrintInvoice || isHistoryPrinting}>
              {isHistoryPrinting ? "Printing..." : "Print"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showDailyReportDialog} onOpenChange={setShowDailyReportDialog}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Print Billing Report</DialogTitle>
            <DialogDescription>
              {selectedDayReport
                ? `${formatIstDateKey(selectedDayReport.dateKey)} Billing Report`
                : "Select printer and copies to print billing report."}
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-3 md:border-r md:pr-4">
              <div className="space-y-2">
                <Label htmlFor="daily-report-copies">No. of Copies</Label>
                <Input
                  id="daily-report-copies"
                  type="number"
                  min={1}
                  step={1}
                  value={dailyReportCopies}
                  onChange={(e) => {
                    const value = Number(e.target.value)
                    setDailyReportCopies(Number.isFinite(value) && value > 0 ? Math.trunc(value) : 1)
                  }}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="daily-report-printer-select">Printer</Label>
                {isTauriRuntime ? (
                  <Select
                    value={historySelectedPrinter}
                    onValueChange={setHistorySelectedPrinter}
                    disabled={isLoadingHistoryPrinters}
                  >
                    <SelectTrigger id="daily-report-printer-select">
                      <SelectValue placeholder={isLoadingHistoryPrinters ? "Loading printers..." : "Select printer"} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={SYSTEM_DEFAULT_PRINTER_VALUE}>System Default</SelectItem>
                      {historyPrinters.map((printer) => (
                        <SelectItem key={printer} value={printer}>
                          {printer}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input id="daily-report-printer-select" value="Browser Print Dialog" disabled />
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="daily-report-paper-size">Paper Size</Label>
                <Select value={historySelectedPaperSize} onValueChange={setHistorySelectedPaperSize}>
                  <SelectTrigger id="daily-report-paper-size">
                    <SelectValue placeholder="Select paper size" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Thermal 80mm">Thermal 80mm</SelectItem>
                    <SelectItem value="Thermal 58mm">Thermal 58mm</SelectItem>
                    <SelectItem value="A4">A4</SelectItem>
                    <SelectItem value="Letter">Letter</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="md:col-span-2 max-h-[70vh] overflow-y-auto rounded border bg-muted/20 p-3">
              {selectedDayReport ? (
                (() => {
                  const report = buildDayReportData(selectedDayReport)
                  return (
                    <div className="bg-white p-4 rounded border text-sm text-black">
                      <h3 className="text-xl font-bold text-center">{report.companyName}</h3>
                      <p className="text-center text-sm mb-4">{report.reportTitle}</p>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Invoice ID</TableHead>
                            <TableHead className="text-right">Bill Amount</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {report.rows.length > 0 ? (
                            report.rows.map((row) => (
                              <TableRow key={row.id}>
                                <TableCell>{row.id}</TableCell>
                                <TableCell className="text-right">{formatCurrency(row.amount)}</TableCell>
                              </TableRow>
                            ))
                          ) : (
                            <TableRow>
                              <TableCell colSpan={2}>No completed bills for this date.</TableCell>
                            </TableRow>
                          )}
                        </TableBody>
                      </Table>
                      <div className="mt-4 space-y-1">
                        <p>Total no of bills: {report.totalBills}</p>
                        <p>Total sum amount: {formatCurrency(report.totalAmount)}</p>
                        <p>
                          Total discount ({report.effectiveDiscountPercentage.toFixed(2)}%):{" "}
                          {formatCurrency(report.totalDiscountAmount)}
                        </p>
                      </div>
                    </div>
                  )
                })()
              ) : (
                <p className="text-sm text-muted-foreground">No day selected for report printing.</p>
              )}
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowDailyReportDialog(false)} disabled={isDailyReportPrinting}>
              Cancel
            </Button>
            <Button onClick={handleConfirmDailyReportPrint} disabled={!selectedDayReport || isDailyReportPrinting}>
              {isDailyReportPrinting ? "Printing..." : "Print"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showAuditDialog} onOpenChange={setShowAuditDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invoice Audit Trail</DialogTitle>
            <DialogDescription>Invoice: {auditInvoiceId}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col sm:flex-row gap-2">
            <Input
              placeholder="Search audit message..."
              value={auditSearchTerm}
              onChange={(e) => setAuditSearchTerm(e.target.value)}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                variant={auditTypeFilter === "all" ? "default" : "outline"}
                onClick={() => setAuditTypeFilter("all")}
              >
                All
              </Button>
              <Button
                size="sm"
                variant={auditTypeFilter === "invoice_revised" ? "default" : "outline"}
                onClick={() => setAuditTypeFilter("invoice_revised")}
              >
                Revised
              </Button>
              <Button
                size="sm"
                variant={auditTypeFilter === "invoice_cancelled" ? "default" : "outline"}
                onClick={() => setAuditTypeFilter("invoice_cancelled")}
              >
                Cancelled
              </Button>
              <Button size="sm" variant="outline" onClick={exportAuditCsv}>
                Export CSV
              </Button>
            </div>
          </div>
          <div className="space-y-2 max-h-80 overflow-y-auto">
            {isAuditLoading ? (
              <p className="text-sm text-muted-foreground">Loading audit events...</p>
            ) : filteredAuditEvents.length === 0 ? (
              <p className="text-sm text-muted-foreground">No audit events found for this invoice.</p>
            ) : (
              pagedAuditEvents.map((event) => (
                <div key={event.id} className="rounded border p-3">
                  <div className="mb-1">
                    <Badge className={getAuditTypeClass(event.type)}>{getAuditTypeLabel(event.type)}</Badge>
                  </div>
                  <p className="text-sm font-medium">{event.notification}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatIstDateTime(event.created_at || "")}
                  </p>
                </div>
              ))
            )}
          </div>
          {!isAuditLoading && filteredAuditEvents.length > 0 && (
            <div className="flex items-center justify-between pt-1">
              <p className="text-xs text-muted-foreground">
                Page {currentAuditPage} of {totalAuditPages} ({filteredAuditEvents.length} events)
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={currentAuditPage <= 1}
                  onClick={() => setAuditPage((prev) => Math.max(1, prev - 1))}
                >
                  Previous
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={currentAuditPage >= totalAuditPages}
                  onClick={() => setAuditPage((prev) => Math.min(totalAuditPages, prev + 1))}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
          {!isAuditLoading && (
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="outline"
                onClick={handleLoadMoreAudit}
                disabled={!auditHasMore || isAuditLoadingMore}
              >
                {isAuditLoadingMore ? "Loading..." : auditHasMore ? "Load More" : "No More Events"}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
