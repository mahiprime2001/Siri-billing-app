"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
// Printing in history is now identical to billing-cart: direct print (no dialog)
import { Eye, Search, Printer } from "lucide-react"
import InvoicePreview from "./invoice-preview"
import PrintableInvoice from "./printable-invoice"
import { apiClient } from "@/lib/api-client"
import { isTauriApp, printHtmlContent } from "@/lib/tauriPrinter"
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

interface BillingHistoryProps {
  currentStore: { id: string; name: string } | null
}

export function BillingHistory({ currentStore }: BillingHistoryProps) {
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

  useEffect(() => {
    setIsTauriRuntime(isTauriApp())
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
      `/api/bills?store_id=${currentStore.id}&limit=100`,
      {
        method: "GET",
      }
    )

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }

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
    }))

    normalized.sort(
      (a: any, b: any) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    )

    setInvoices(normalized)
    setFilteredInvoices(normalized)

    console.log(`✅ Loaded ${normalized.length} invoices from backend`)
  } catch (error) {
    console.error("❌ Failed to fetch billing history:", error)
  }
  }, [currentStore])

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
          product.hsn_code ||
          product.hsnCode ||
          hsnFromProduct ||
          item.hsn_code ||
          item.hsnCode ||
          ""
        return {
          id: item.id,
          productId: item.productid || item.product_id,
          name: product.name || item.name || "Unknown Item",
          quantity: item.quantity || 0,
          price: item.price || item.unit_price || 0,
          total: item.total || item.item_total || 0,
          barcodes: product.barcode || "",
          taxPercentage: product.tax || item.taxPercentage || 0,
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

  // Direct print flow using PrintableInvoice (isolated iframe)
  const handlePrintInvoice = async (invoice: Invoice) => {
    if (printingInvoiceId) return
    setPrintingInvoiceId(invoice.id)
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
    setSelectedInvoice(printable)

    // Wait a tick for PrintableInvoice to render into the ref
    await new Promise((resolve) => setTimeout(resolve, 0))

    const printOuter = printRef.current?.outerHTML || ""
    const printContent = generatePrintHTML(printOuter, printPaperSize, printable.id || "invoice")

    try {
      if (isTauriRuntime) {
        const result = await printHtmlContent(printContent, { paperSize: printPaperSize })
        console.log("✅ [BillingHistory] Tauri print submitted:", result)
        toast({
          title: "Print job queued",
          description: "Printer: System default",
          variant: "default",
        })
        return
      }

      const result = await safePrint(printContent, printPaperSize)
      if (!result.success) {
        console.error("❌ [BillingHistory] Browser print failed:", result.error)
      }
    } catch (error) {
      console.error("❌ [BillingHistory] Print failed:", error)
    } finally {
      setPrintingInvoiceId(null)
    }
  }

  const generatePrintHTML = (printContent: string, paperSize: string, invoiceId: string): string => {
    const getPageStyles = (): string => {
      if (paperSize === "Thermal 58mm") {
        return `
          @page { size: 58mm auto; margin: 0; }
          body { width: 58mm; margin: 0; padding: 2mm; }
        `
      } else if (paperSize === "Thermal 80mm") {
        return `
          @page { size: 80mm auto; margin: 0; }
          body { width: 80mm; margin: 0; padding: 2mm; }
        `
      } else if (paperSize === "A4") {
        return `
          @page { size: A4 portrait; margin: 0; }
          body { margin: 0; padding: 15mm 10mm; }
        `
      } else if (paperSize === "Letter") {
        return `
          @page { size: Letter portrait; margin: 0; }
          body { margin: 0; padding: 0.6in 0.4in; }
        `
      }
      return `
        @page { size: A4 portrait; margin: 0; }
        body { margin: 0; padding: 15mm 10mm; }
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
                {filteredInvoices.map((invoice) => (
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
                    <TableCell>{new Date(invoice.timestamp).toLocaleString()}</TableCell>
                    <TableCell>₹{invoice.total.toLocaleString()}</TableCell>
                    <TableCell>
                      <Badge className={getStatusColor(invoice.status || "completed")}>
                        {invoice.status || "Completed"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex space-x-2">
                        <Button variant="outline" size="sm" onClick={() => handleViewInvoice(invoice)}>
                          <Eye className="h-4 w-4 mr-1" />
                          View
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
          )}
        </CardContent>
      </Card>

      {showPreview && selectedInvoice && (
        <InvoicePreview
          invoice={selectedInvoice}
          isOpen={showPreview}
          onClose={() => setShowPreview(false)}
          initialPaperSize={printPaperSize}
        />
      )}

      {/* Printable invoice directly used for billing-history printing */}
      <div className="hidden print:block">
        {selectedInvoice && (
          <PrintableInvoice ref={printRef} invoice={selectedInvoice} paperSize={printPaperSize} />
        )}
      </div>
    </>
  )
}
