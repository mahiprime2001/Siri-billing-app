"use client"

import { useRef, useState, useEffect } from "react"

interface Customer {
  id: string;
  name: string;
  phone: string;
  email?: string;
  address?: string;
}

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Save, Printer, AlertCircle, User, CreditCard } from "lucide-react"
import PrintableInvoice from "./printable-invoice"
import { safePrint } from "@/lib/printUtils"
import { isTauriApp, listPrinters, silentPrintText } from "@/lib/tauriPrinter"
import { generateReceiptText } from "@/lib/receiptText"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"



interface InvoicePreviewProps {
  invoice: Invoice
  isOpen: boolean
  onClose: () => void
  onSave?: (updatedInvoice: Invoice) => void
  onPrintAndSave?: (updatedInvoice: Invoice) => void
  initialPaperSize?: string
  initialCustomerName?: string
  initialCustomerPhone?: string
  initialPaymentMethod?: string
}

export default function InvoicePreview({
  invoice,
  isOpen,
  onClose,
  onSave,
  onPrintAndSave,
  initialPaperSize = "Thermal 80mm",
  initialCustomerName = "Walk-in Customer",
  initialCustomerPhone = "",
  initialPaymentMethod = "Cash",
}: InvoicePreviewProps) {
  const printRef = useRef<HTMLDivElement>(null)
  const nameInputRef = useRef<HTMLDivElement>(null)
  const phoneInputRef = useRef<HTMLDivElement>(null)
  
  const [isPrinting, setIsPrinting] = useState(false)
  const [printError, setPrintError] = useState<string | null>(null)

  // Editable states
  const [customerName, setCustomerName] = useState(initialCustomerName)
  const [customerPhone, setCustomerPhone] = useState(initialCustomerPhone)
  const [paymentMethod, setPaymentMethod] = useState(initialPaymentMethod)
  const [paperSize, setPaperSize] = useState(initialPaperSize)
  const [availablePrinters, setAvailablePrinters] = useState<string[]>([])
  const [selectedPrinter, setSelectedPrinter] = useState("SYSTEM_DEFAULT")
  const [isTauriRuntime, setIsTauriRuntime] = useState(false)
  const [printCopies, setPrintCopies] = useState(2)
  const [printerDebug, setPrinterDebug] = useState(false)

  // Autocomplete states
  const [customers, setCustomers] = useState<Customer[]>([])
  const [filteredCustomers, setFilteredCustomers] = useState<Customer[]>([])
  const [showNameSuggestions, setShowNameSuggestions] = useState(false)
  const [showPhoneSuggestions, setShowPhoneSuggestions] = useState(false)

  // Update internal states when initial props change
  useEffect(() => {
    setCustomerName(initialCustomerName)
    setCustomerPhone(initialCustomerPhone)
    setPaymentMethod(initialPaymentMethod)
    setPaperSize(initialPaperSize)
  }, [initialCustomerName, initialCustomerPhone, initialPaymentMethod, initialPaperSize])

  useEffect(() => {
    if (!isOpen) return

    const loadPrinters = async () => {
      const tauri = isTauriApp()
      setIsTauriRuntime(tauri)
      if (!tauri) {
        setAvailablePrinters([])
        return
      }
      try {
        const debugFlag =
          typeof window !== "undefined" &&
          window.localStorage.getItem("printerDebug") === "true"
        setPrinterDebug(debugFlag)
      } catch {
        setPrinterDebug(false)
      }
      const printers = await listPrinters()
      setAvailablePrinters(printers)
    }

    loadPrinters()
  }, [isOpen])

  // Simplified fetch - just get customers directly
  useEffect(() => {
    const fetchCustomers = async () => {
      try {
        const customersResponse = await fetch('http://localhost:8080/api/customers', {
          method: 'GET',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
          }
        })
        
        if (customersResponse.ok) {
          const data = await customersResponse.json()
          console.log('✅ Fetched customers:', data)
          
          // Filter out Walk-in customers
          const validCustomers = data.filter((c: any) => 
            c.name && c.name !== 'Walk-in Customer'
          )
          
          setCustomers(validCustomers)
        }
      } catch (error) {
        console.error('❌ Error fetching customers:', error)
        setCustomers([])
      }
    }

    if (isOpen) {
      fetchCustomers()
    }
  }, [isOpen])

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (nameInputRef.current && !nameInputRef.current.contains(event.target as Node)) {
        setShowNameSuggestions(false)
      }
      if (phoneInputRef.current && !phoneInputRef.current.contains(event.target as Node)) {
        setShowPhoneSuggestions(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Filter customers based on name input
  const handleNameChange = (value: string) => {
    setCustomerName(value)
    
    console.log('🔍 Name input:', value)
    console.log('👥 Total customers:', customers.length)
    console.log('👥 All customers:', customers)
    
    if (value.trim().length > 0) {
      const filtered = customers.filter(customer => {
        console.log('🔎 Checking customer:', customer)
        if (!customer.name || typeof customer.name !== 'string') {
          return false
        }
        const match = customer.name.toLowerCase().includes(value.toLowerCase())
        console.log(`🔎 "${customer.name}" matches "${value}": ${match}`)
        return match
      })
      
      console.log('✨ Filtered customers:', filtered)
      console.log('✨ Filtered count:', filtered.length)
      
      setFilteredCustomers(filtered)
      setShowNameSuggestions(filtered.length > 0)
      setShowPhoneSuggestions(false)
    } else {
      setShowNameSuggestions(false)
      setFilteredCustomers([])
    }
  }

  // Filter customers based on phone input
  const handlePhoneChange = (value: string) => {
    setCustomerPhone(value)
    
    console.log('📱 Phone input:', value)
    console.log('👥 Total customers:', customers.length)
    
    if (value.trim().length > 0) {
      const filtered = customers.filter(customer => {
        if (!customer.phone || typeof customer.phone !== 'string') {
          return false
        }
        return customer.phone.includes(value)
      })
      
      console.log('✨ Filtered customers by phone:', filtered)
      
      setFilteredCustomers(filtered)
      setShowPhoneSuggestions(filtered.length > 0)
      setShowNameSuggestions(false)
    } else {
      setShowPhoneSuggestions(false)
      setFilteredCustomers([])
    }
  }

  // Select customer from suggestions - AUTO FILLS BOTH NAME AND PHONE
  const selectCustomer = (customer: Customer) => {
    console.log('✅ Selected customer:', customer)
    // Auto-fill BOTH name and phone
    setCustomerName(customer.name)
    setCustomerPhone(customer.phone)
    // Close both dropdowns
    setShowNameSuggestions(false)
    setShowPhoneSuggestions(false)
    setFilteredCustomers([])
  }

  const getUpdatedInvoice = (): Invoice => ({
    ...invoice,
    customerName,
    customerPhone,
    paymentMethod,
    billFormat: paperSize,
    discountPercentage: invoice.discountPercentage,
    discountAmount: invoice.discountAmount,
    total: invoice.total,
    taxAmount: invoice.taxAmount,
  })

  const handleSaveClick = () => {
    if (onSave) {
      onSave(getUpdatedInvoice())
    }
  }

  const handlePrintAndSaveClick = async () => {
    setIsPrinting(true)
    setPrintError(null)
    try {
      const updatedInvoice = getUpdatedInvoice()
      if (onPrintAndSave) {
        console.log("💾 [InvoicePreview] Saving invoice...")
        await onPrintAndSave(updatedInvoice)
      }
      await handlePrint()
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "An error occurred during save and print."
      console.error("❌ [InvoicePreview] Print and save error:", error)
      setPrintError(errorMessage)
      setIsPrinting(false)
    }
  }

  const handlePrint = async () => {
    if (!printRef.current) {
      setPrintError("Print content not available. Please try again.")
      return
    }

    setIsPrinting(true)
    setPrintError(null)

    try {
      const updatedInvoice = getUpdatedInvoice()
      const isThermal = paperSize.includes("Thermal")

      if (isTauriRuntime && isThermal) {
        const printer = selectedPrinter === "SYSTEM_DEFAULT" ? undefined : selectedPrinter
        const storeCopy = generateReceiptText(updatedInvoice, paperSize, [
          { label: "Store Copy" },
        ])
        const customerCopy = generateReceiptText(updatedInvoice, paperSize, [
          { label: "Customer Copy" },
        ])

        console.log("🖨 [InvoicePreview] Starting silent print (multiple jobs)...")
        const copies = Math.max(1, Number.isFinite(printCopies) ? printCopies : 1)
        for (let i = 0; i < copies; i += 1) {
          const content = i % 2 === 0 ? storeCopy : customerCopy
          await silentPrintText(content, {
            printerName: printer,
            paperSize,
            copies: 1,
          })
        }
        console.log("✅ [InvoicePreview] Silent print completed successfully")
        setIsPrinting(false)
        return
      }

      const printContent = printRef.current.innerHTML
      const htmlContent = generatePrintHTML(printContent, paperSize, invoice.id)

      console.log("🖨 [InvoicePreview] Starting print dialog...")
      const result = await safePrint(htmlContent, paperSize)

      if (!result.success) {
        setPrintError(result.error || "Failed to print. Please try again.")
      } else {
        console.log("✅ [InvoicePreview] Print completed successfully")
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "An unexpected error occurred while printing."
      console.error("❌ [InvoicePreview] Print error:", error)
      setPrintError(errorMessage)
    } finally {
      setIsPrinting(false)
    }
  }

  const handlePrintAndSave = async () => {
    setIsPrinting(true)
    setPrintError(null)

    try {
      if (onPrintAndSave) {
        console.log("💾 [InvoicePreview] Saving invoice...")
        await onPrintAndSave(getUpdatedInvoice())
      }
      await handlePrint()
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "An error occurred during save and print."
      console.error("❌ [InvoicePreview] Print and save error:", error)
      setPrintError(errorMessage)
      setIsPrinting(false)
    }
  }

  const handleClose = () => {
    setPrintError(null)
    onClose()
  }

  const isThermal = paperSize.includes("Thermal")
  const isA4 = paperSize === "A4"
  const isLetter = paperSize === "Letter"

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-visible">
        <DialogHeader>
          <DialogTitle>Tax Invoice Preview - {invoice.id}</DialogTitle>
          <DialogDescription>
            Review the invoice details before saving or printing.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 max-h-[70vh] overflow-y-auto">
          {/* Left Column: Customer Info, Payment, Print Type */}
          <div className="lg:col-span-1 space-y-4 overflow-visible">
            {/* Customer Information */}
            <div className="p-4 border rounded-lg shadow-sm bg-gray-50 overflow-visible">
              <h3 className="font-semibold text-lg mb-2 flex items-center">
                <User className="h-5 w-5 mr-2" /> Customer Details
              </h3>
              
              {/* Customer Name with Dropdown */}
              <div className="space-y-2 mb-4" ref={nameInputRef}>
                <Label htmlFor="customerName">Customer Name</Label>
                <div className="relative">
                  <Input
                    id="customerName"
                    value={customerName}
                    onChange={(e) => handleNameChange(e.target.value)}
                    onFocus={() => {
                      if (customerName.trim().length > 0 && filteredCustomers.length > 0) {
                        setShowNameSuggestions(true)
                      }
                    }}
                    placeholder="Walk-in Customer"
                    autoComplete="off"
                  />
                  
                  {/* Suggestions Dropdown for Name */}
                  {showNameSuggestions && filteredCustomers.length > 0 && (
                    <div 
                      className="absolute left-0 right-0 mt-1 bg-white border-2 border-blue-400 rounded-md shadow-xl max-h-60 overflow-auto"
                      style={{ zIndex: 9999 }}
                    >
                      {filteredCustomers.map((customer) => (
                        <div
                          key={customer.id}
                          className="px-4 py-3 cursor-pointer hover:bg-blue-50 active:bg-blue-100 border-b last:border-b-0 transition-colors"
                          onClick={() => selectCustomer(customer)}
                        >
                          <div className="font-semibold text-gray-900">{customer.name}</div>
                          <div className="text-sm text-gray-600">📱 {customer.phone || 'No phone'}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Customer Phone with Dropdown */}
              <div className="space-y-2" ref={phoneInputRef}>
                <Label htmlFor="customerPhone">Customer Phone</Label>
                <div className="relative">
                  <Input
                    id="customerPhone"
                    value={customerPhone}
                    onChange={(e) => handlePhoneChange(e.target.value)}
                    onFocus={() => {
                      if (customerPhone.trim().length > 0 && filteredCustomers.length > 0) {
                        setShowPhoneSuggestions(true)
                      }
                    }}
                    placeholder="N/A"
                    autoComplete="off"
                  />
                  
                  {/* Suggestions Dropdown for Phone */}
                  {showPhoneSuggestions && filteredCustomers.length > 0 && (
                    <div 
                      className="absolute left-0 right-0 mt-1 bg-white border-2 border-blue-400 rounded-md shadow-xl max-h-60 overflow-auto"
                      style={{ zIndex: 9999 }}
                    >
                      {filteredCustomers.map((customer) => (
                        <div
                          key={customer.id}
                          className="px-4 py-3 cursor-pointer hover:bg-blue-50 active:bg-blue-100 border-b last:border-b-0 transition-colors"
                          onClick={() => selectCustomer(customer)}
                        >
                          <div className="font-semibold text-gray-900">{customer.name}</div>
                          <div className="text-sm text-gray-600">📱 {customer.phone || 'No phone'}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Payment Method */}
            <div className="p-4 border rounded-lg shadow-sm bg-gray-50">
              <h3 className="font-semibold text-lg mb-2 flex items-center">
                <CreditCard className="h-5 w-5 mr-2" /> Payment Method
              </h3>
              <Select value={paymentMethod} onValueChange={setPaymentMethod}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Cash">💵 Cash</SelectItem>
                  <SelectItem value="UPI">📱 UPI</SelectItem>
                  <SelectItem value="Card">💳 Card</SelectItem>
                  <SelectItem value="UPI+Cash">UPI+Cash</SelectItem>
                  <SelectItem value="Card+Cash">Card+Cash</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Print Type */}
            {/* Print Format removed from preview as requested */}

            {/* Printer Selection (Desktop App) */}
            {isTauriRuntime && (
              <div className="p-4 border rounded-lg shadow-sm bg-gray-50">
                <h3 className="font-semibold text-lg mb-2 flex items-center">
                  <Printer className="h-5 w-5 mr-2" /> Printer
                </h3>
                <Select value={selectedPrinter} onValueChange={setSelectedPrinter}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="SYSTEM_DEFAULT">System Default</SelectItem>
                    {availablePrinters.map((printer) => (
                      <SelectItem key={printer} value={printer}>
                        {printer}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {availablePrinters.length === 0 && (
                  <p className="text-xs text-gray-500 mt-2">
                    No printers detected by the desktop app. If this is Windows,
                    we can try a different enumeration method.
                  </p>
                )}
                <div className="mt-4">
                  <Label htmlFor="printCopies">Copies</Label>
                  <Input
                    id="printCopies"
                    type="number"
                    min={1}
                    step={1}
                    value={printCopies}
                    onChange={(e) => {
                      const value = Number.parseInt(e.target.value, 10)
                      setPrintCopies(Number.isNaN(value) ? 2 : Math.max(1, value))
                    }}
                  />
                </div>
                <div className="mt-4 flex items-center gap-2">
                  <input
                    id="printerDebug"
                    type="checkbox"
                    checked={printerDebug}
                    onChange={(e) => {
                      const checked = e.target.checked
                      setPrinterDebug(checked)
                      try {
                        window.localStorage.setItem("printerDebug", String(checked))
                      } catch {
                        // ignore storage errors
                      }
                    }}
                  />
                  <Label htmlFor="printerDebug">Enable Printer Debug Logs</Label>
                </div>
              </div>
            )}

            {/* Error Alert */}
            {printError && (
              <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-md">
                <div className="flex items-center">
                  <AlertCircle className="h-4 w-4 mr-2" />
                  <div>
                    <strong>Print Error:</strong> {printError}
                    <br />
                    <span className="text-sm">
                      Please resolve the issue and try again.
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Right Column: Invoice Preview */}
          <div className="lg:col-span-2 space-y-4">
            <div className="bg-white mx-auto shadow-lg border rounded-lg overflow-hidden">
              <div className="p-4 bg-gray-50 border-b">
                <p className="text-sm text-gray-600">
                  Preview - This is how your invoice will look when printed
                </p>
              </div>
              <div className="p-4 max-h-96 overflow-y-auto">
                <div
                  className={`mx-auto ${
                    isThermal && paperSize === "Thermal 80mm"
                      ? "w-[80mm]"
                      : isThermal && paperSize === "Thermal 58mm"
                      ? "w-[58mm]"
                      : isA4
                      ? "max-w-2xl"
                      : isLetter
                      ? "max-w-2xl"
                      : "max-w-2xl"
                  }`}
                  style={
                    isThermal
                      ? { transformOrigin: "top center" }
                      : { transform: "scale(0.8)", transformOrigin: "top center" }
                  }
                >
                  <PrintableInvoice invoice={getUpdatedInvoice()} paperSize={paperSize} />
                </div>
              </div>
            </div>

            {/* Hidden Printable Component */}
            <div style={{ display: "none" }}>
              <PrintableInvoice ref={printRef} invoice={getUpdatedInvoice()} paperSize={paperSize} />
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <DialogFooter className="flex justify-center sm:justify-center space-x-4 mt-4">
          <Button
            onClick={handlePrintAndSave}
            className="bg-blue-600 hover:bg-blue-700"
            disabled={isPrinting}
          >
            <Printer className="h-4 w-4 mr-2" />
            {isPrinting ? "Processing..." : "Print & Save"}
          </Button>

          {onSave && (
            <Button onClick={handleSaveClick} variant="outline" disabled={isPrinting}>
              <Save className="h-4 w-4 mr-2" />
              Save Only
            </Button>
          )}

          <Button variant="outline" onClick={handleClose} disabled={isPrinting}>
            Close
          </Button>

          {/* Loading indicator */}
          {isPrinting && (
            <div className="text-center text-sm text-gray-600 ml-4">
              <div className="inline-flex items-center">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600 mr-2"></div>
                Preparing print...
              </div>
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Generate complete HTML for printing with proper styles
 */
function generatePrintHTML(printContent: string, paperSize: string, invoiceId: string): string {
  const getPageStyles = (): string => {
    if (paperSize === "Thermal 58mm") {
      return `
        @page {
          size: 58mm auto;
          margin: 1mm 2mm;
        }
        body {
          width: 48mm;
        }
      `
    } else if (paperSize === "Thermal 80mm") {
      return `
        @page {
          size: 80mm auto;
          margin: 2mm 3mm;
        }
        body {
          width: 72mm;
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
  const labelStyle = isThermal
    ? "font-size: 10px; text-align: center; margin: 0 0 4px 0; font-weight: bold;"
    : "font-size: 12px; text-align: center; margin: 0 0 8px 0; font-weight: bold;"

  const separator = isThermal
    ? `<div style="border-top: 1px dashed #000; margin: 8px 0;"></div>`
    : `<div style="page-break-after: always;"></div>`

  const copyBlock = (label: string) => `
    <div class="print-copy">
      <div style="${labelStyle}">${label}</div>
      ${printContent}
    </div>
  `

  const copiesContent = `
    ${copyBlock("Store Copy")}
    ${separator}
    ${copyBlock("Customer Copy")}
  `

  return `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Invoice-${invoiceId}</title>
        <style>
          ${getPageStyles()}
          * { box-sizing: border-box; }
          html, body {
            margin: 0;
            padding: 0;
            font-family: Arial, sans-serif;
            font-size: ${paperSize.includes("Thermal") ? "11px" : "14px"};
            line-height: 1.4;
            -webkit-print-color-adjust: exact;
            background: white;
          }
          @media print {
            html, body {
              margin: 0 !important;
              padding: 0 !important;
              overflow: visible !important;
            }
            .no-print { display: none !important; }
            .invoice-section { page-break-inside: avoid; margin-bottom: 6px; }
          }
          .print-container {
            width: 100%;
            max-width: 100%;
            padding: 0;
            margin: 0 auto;
          }
          .print-copy {
            width: 100%;
          }
        </style>
      </head>
      <body>
        <div class="print-container">
          ${copiesContent}
        </div>
      </body>
    </html>
  `
}
