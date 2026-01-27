"use client"

import { useState, useEffect, useCallback } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Eye, Search, Printer } from "lucide-react"
import InvoicePreview from "./invoice-preview"
import { apiClient } from "@/lib/api-client"

// Raw invoice shape returned by backend (snake_case).
interface RawInvoice {
  [key: string]: any
}

interface BillingHistoryProps {
  currentStore: { id: string; name: string } | null
}

export function BillingHistory({ currentStore }: BillingHistoryProps) {
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [filteredInvoices, setFilteredInvoices] = useState<Invoice[]>([])
  const [searchTerm, setSearchTerm] = useState("")
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null)
  const [showPreview, setShowPreview] = useState(false)
  const [showPrintDialog, setShowPrintDialog] = useState(false)
  const [printInvoice, setPrintInvoice] = useState<Invoice | null>(null)
  const [printPaperSize, setPrintPaperSize] = useState("Thermal 80mm")

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


  useEffect(() => {
    fetchBillingHistory()

    // Refresh every 30 seconds
    const refreshInterval = setInterval(fetchBillingHistory, 30 * 1000)
    return () => clearInterval(refreshInterval)
  }, [fetchBillingHistory])

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

  const handleViewInvoice = (invoice: Invoice) => {
    setSelectedInvoice(invoice)
    setShowPreview(true)
  }

  const handlePrintInvoice = (invoice: Invoice) => {
    setPrintInvoice(invoice)
    setShowPrintDialog(true)
  }

  const handleConfirmPrint = () => {
    if (printInvoice) {
      setShowPrintDialog(false)
      setSelectedInvoice(printInvoice)
      setShowPreview(true)

      setTimeout(() => {
        const printWindow = window.open("", "_blank")
        if (printWindow) {
          const printContent = generatePrintContent(printInvoice, printPaperSize)
          printWindow.document.write(printContent)
          printWindow.document.close()
          printWindow.focus()
          setTimeout(() => {
            printWindow.print()
            printWindow.close()
          }, 250)
        }
      }, 500)
    }
  }

  const generatePrintContent = (invoice: Invoice, paperSize: string) => {
    const customerName = getCustomerName(invoice)
    const customerPhone = getCustomerPhone(invoice)
    const storeName = getStoreName(invoice)
    const storeAddress = getStoreAddress(invoice)
    const storePhone = getStorePhone(invoice)
    const storeEmail = invoice.companyEmail || "info@siriartjewellers.com"
    const gstin = invoice.gstin || "27ABCDE1234F1Z5"

    const getPageStyles = () => {
      if (paperSize === "Thermal 58mm" || paperSize === "Thermal 80mm") {
        return `
          @page {
            size: ${paperSize === "Thermal 58mm" ? "58mm auto" : "80mm auto"};
            margin: 2mm;
          }
        `
      } else if (paperSize === "A4") {
        return `
          @page {
            size: A4 portrait;
            margin: 15mm 10mm;
          }
        `
      } else if (paperSize === "Letter") {
        return `
          @page {
            size: Letter portrait;
            margin: 0.6in 0.4in;
          }
        `
      }
      return `
        @page {
          size: A4 portrait;
          margin: 15mm 10mm;
        }
      `
    }

    const isThermal = paperSize.includes("Thermal")

    const thermalContent = `
      <div style="width: ${
        paperSize === "Thermal 58mm" ? "58mm" : "80mm"
      }; font-family: Courier New, monospace; font-size: ${
      paperSize === "Thermal 58mm" ? "10px" : "11px"
    }; line-height: ${paperSize === "Thermal 58mm" ? "1.2" : "1.3"}; color: #000;">
        <div style="text-align: center; margin-bottom: 8px;">
          <div style="font-size: 14px; font-weight: bold;">${storeName.toUpperCase()}</div>
          <div style="font-size: 12px;">${storeAddress}</div>
          <div style="font-size: 12px;">Ph: ${storePhone}</div>
          <div style="font-size: 12px;">${storeEmail}</div>
          <div style="font-size: 12px;">GSTIN: ${gstin}</div>
          <div style="border-top: 1px dashed #000; margin: 4px 0;"></div>
          <div style="font-size: 12px; font-weight: bold;">TAX INVOICE</div>
        </div>
        
        <div style="font-size: 12px; margin-bottom: 8px;">
          <div style="display: flex; justify-content: space-between;">
              <span>Invoice: ${invoice.id}</span>
              <span>${new Date(invoice.timestamp).toLocaleDateString()}</span>
            </div>
            <div style="display: flex; justify-content: space-between;">
              <span>Payment: ${invoice.paymentMethod || "Cash"}</span>
            </div>
        </div>

        ${
          customerName !== "Walk-in Customer" || customerPhone
            ? `
          <div style="font-size: 12px; margin-bottom: 8px;">
            <div style="border-top: 1px dashed #000; margin: 4px 0;"></div>
            <div>Customer: ${customerName}</div>
            ${customerPhone ? `<div>Phone: ${customerPhone}</div>` : ""}
            <div style="border-top: 1px dashed #000; margin: 4px 0;"></div>
          </div>
        `
            : ""
        }

        <div style="font-size: 12px; margin-bottom: 8px;">
          ${
            invoice.items
              ?.map(
                (item: any, index: number) => `
            <div style="margin-bottom: 4px;">
              <div style="display: flex; justify-content: space-between;">
                <span style="flex: 1;">${item.name || "Unknown Item"}</span>
              </div>
              <div style="display: flex; justify-content: space-between;">
                <span>${item.quantity} x ₹${item.price.toLocaleString()}</span>
                <span>₹${item.total.toLocaleString()}</span>
              </div>
              ${
                index < (invoice.items?.length || 0) - 1
                  ? '<div style="border-top: 1px dotted #000; margin: 2px 0;"></div>'
                  : ""
              }
            </div>
          `
              )
              .join("") || ""
          }
        </div>

          <div style="font-size: 12px;">
          <div style="border-top: 1px dashed #000; margin: 4px 0;"></div>
          <div style="display: flex; justify-content: space-between;">
            <span>Subtotal:</span>
            <span>₹${invoice.subtotal.toLocaleString()}</span>
          </div>
          ${
            invoice.discountPercentage > 0
              ? `
            <div style="display: flex; justify-content: space-between;">
              <span>Discount (${invoice.discountPercentage}%):</span>
              <span>-₹${invoice.discountAmount.toLocaleString()}</span>
            </div>
          `
              : ""
          }
          <div style="display: flex; justify-content: space-between;">
            <span>Tax (${invoice.taxPercentage}%):</span>
            <span>₹${invoice.taxAmount.toLocaleString()}</span>
          </div>
          <div style="border-top: 1px dashed #000; margin: 4px 0;"></div>
          <div style="display: flex; justify-content: space-between; font-weight: bold; font-size: 14px;">
            <span>TOTAL:</span>
            <span>₹${invoice.total.toLocaleString()}</span>
          </div>
          <div style="border-top: 1px dashed #000; margin: 4px 0;"></div>
        </div>

        <div style="text-align: center; font-size: 12px; margin-top: 8px;">
          <div>Thank you for your business!</div>
          <div>This is a computer generated invoice</div>
        </div>
      </div>
    `

    const standardContent = `
      <div style="width: 100%; font-size: 11px; line-height: 1.3; color: #000;">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px;">
          <div>
            <h1 style="font-size: 24px; font-weight: bold; margin: 0 0 4px 0;">${storeName}</h1>
            <p style="margin: 2px 0;">${storeAddress}</p>
            <p style="margin: 2px 0;">Phone: ${storePhone} | Email: ${storeEmail}</p>
            <p style="margin: 2px 0;">GSTIN: ${gstin}</p>
          </div>
          <div style="text-align: right;">
            <h2 style="font-size: 20px; font-weight: bold; margin: 0 0 4px 0;">TAX INVOICE</h2>
            <p style="margin: 2px 0;">#${invoice.id}</p>
            <p style="margin: 2px 0;">Date: ${new Date(invoice.timestamp).toLocaleDateString()}</p>
            <p style="margin: 2px 0;">Payment: ${invoice.paymentMethod || "Cash"}</p>
          </div>
        </div>

        <div style="margin-bottom: 20px;">
          <h3 style="font-size: 18px; font-weight: 600; margin-bottom: 8px;">Bill To:</h3>
          <p style="font-weight: 500; margin: 2px 0;">${customerName}</p>
          ${customerPhone ? `<p style="margin: 2px 0;">${customerPhone}</p>` : ""}
        </div>

        <div style="margin-bottom: 20px;">
          <table style="width: 100%; border-collapse: collapse; border: 1px solid #000;">
            <thead>
              <tr style="background-color: #f5f5f5;">
                <th style="border: 1px solid #000; padding: 8px; text-align: left;">Item</th>
                <th style="border: 1px solid #000; padding: 8px; text-align: right;">Price</th>
                <th style="border: 1px solid #000; padding: 8px; text-align: right;">Qty</th>
                <th style="border: 1px solid #000; padding: 8px; text-align: right;">Total</th>
              </tr>
            </thead>
            <tbody>
              ${
                invoice.items
                  ?.map(
                    (item: any) => `
                <tr>
                  <td style="border: 1px solid #000; padding: 8px;">${item.name || "Unknown Item"}</td>
                  <td style="border: 1px solid #000; padding: 8px; text-align: right;">₹${item.price.toLocaleString()}</td>
                  <td style="border: 1px solid #000; padding: 8px; text-align: right;">${item.quantity}</td>
                  <td style="border: 1px solid #000; padding: 8px; text-align: right;">₹${item.total.toLocaleString()}</td>
                </tr>
              `
                  )
                  .join("") || ""
              }
            </tbody>
          </table>
        </div>

        <div style="display: flex; justify-content: flex-end; margin-bottom: 20px;">
          <div style="width: 256px;">
            <div style="display: flex; justify-content: space-between; padding: 8px 0;">
              <span>Subtotal:</span>
              <span>₹${invoice.subtotal.toLocaleString()}</span>
            </div>
            ${
              invoice.discountPercentage > 0
                ? `
              <div style="display: flex; justify-content: space-between; padding: 8px 0;">
                <span>Discount (${invoice.discountPercentage}%):</span>
                <span>-₹${invoice.discountAmount.toLocaleString()}</span>
              </div>
            `
                : ""
            }
            <div style="display: flex; justify-content: space-between; padding: 8px 0;">
              <span>Tax (${invoice.taxPercentage}%):</span>
              <span>₹${invoice.taxAmount.toLocaleString()}</span>
            </div>
            <div style="display: flex; justify-content: space-between; padding: 8px 0; border-top: 1px solid #000; font-weight: bold; font-size: 18px;">
              <span>Total Amount:</span>
              <span>₹${invoice.total.toLocaleString()}</span>
            </div>
          </div>
        </div>

        <div style="text-align: center; font-size: 14px; border-top: 1px solid #ccc; padding-top: 16px;">
          <p style="margin: 2px 0;">Thank you for your business!</p>
          <p style="margin: 2px 0;">This is a computer generated tax invoice</p>
          <p style="margin: 2px 0;">For any queries, please contact us at ${storeEmail}</p>
        </div>
      </div>
    `

    return `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Invoice-${invoice.id}</title>
          <style>
            ${getPageStyles()}
            
            body {
              margin: 0;
              padding: 0;
              -webkit-print-color-adjust: exact;
              color-adjust: exact;
              font-family: Arial, sans-serif;
            }
            
            @media print {
              body {
                -webkit-print-color-adjust: exact;
                color-adjust: exact;
              }
              
              * {
                box-sizing: border-box;
              }
            }
          </style>
        </head>
        <body>
          ${isThermal ? thermalContent : standardContent}
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
                        <Button variant="outline" size="sm" onClick={() => handlePrintInvoice(invoice)}>
                          <Printer className="h-4 w-4 mr-1" />
                          Print
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

      {/* Print Options Dialog */}
      <Dialog open={showPrintDialog} onOpenChange={setShowPrintDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Print Invoice - {printInvoice?.id}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="printPaperSize">Select Paper Size</Label>
              <Select value={printPaperSize} onValueChange={setPrintPaperSize}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Thermal 80mm">🧾 Thermal 80mm (Receipt)</SelectItem>
                  <SelectItem value="Thermal 58mm">🧾 Thermal 58mm (Small Receipt)</SelectItem>
                  <SelectItem value="A4">📄 A4 (Standard)</SelectItem>
                  <SelectItem value="Letter">📄 Letter (US Standard)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="bg-gray-50 p-3 rounded-md">
              <p className="text-sm text-gray-600">
                <strong>Selected:</strong> {printPaperSize}
              </p>
              <p className="text-xs text-gray-500 mt-1">
                {printPaperSize.includes("Thermal")
                  ? "Optimized for thermal receipt printers"
                  : "Standard document format with margins"}
              </p>
            </div>

            <div className="flex justify-end space-x-2">
              <Button variant="outline" onClick={() => setShowPrintDialog(false)}>
                Cancel
              </Button>
              <Button onClick={handleConfirmPrint}>
                <Printer className="h-4 w-4 mr-2" />
                Print Now
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {showPreview && selectedInvoice && (
        <InvoicePreview
          invoice={selectedInvoice}
          isOpen={showPreview}
          onClose={() => setShowPreview(false)}
          initialPaperSize={printPaperSize}
        />
      )}
    </>
  )
}
