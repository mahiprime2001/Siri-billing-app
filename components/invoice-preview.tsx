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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useToast } from "@/components/ui/use-toast"
import { apiClient } from "@/lib/api-client"



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
  const { toast } = useToast()
  
  const [isPrinting, setIsPrinting] = useState(false)
  const [printError, setPrintError] = useState<string | null>(null)
  const [discountApprovalStatus, setDiscountApprovalStatus] = useState<Invoice["discountApprovalStatus"]>(
    invoice.discountApprovalStatus || "not_required"
  )
  const [discountRequestId, setDiscountRequestId] = useState<string | undefined>(invoice.discountRequestId)

  // Editable states
  const [customerName, setCustomerName] = useState(initialCustomerName)
  const [customerPhone, setCustomerPhone] = useState(initialCustomerPhone)
  const [paymentMethod, setPaymentMethod] = useState(initialPaymentMethod)
  const [paperSize, setPaperSize] = useState(initialPaperSize)

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
    setDiscountApprovalStatus(invoice.discountApprovalStatus || "not_required")
    setDiscountRequestId(invoice.discountRequestId)
  }, [invoice.discountApprovalStatus, invoice.discountRequestId])

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

  useEffect(() => {
    if (!discountRequestId || discountApprovalStatus !== "pending") return

    let cancelled = false

    const pollStatus = async () => {
      try {
        const response = await apiClient(`/api/discounts/${discountRequestId}`)
        if (!response.ok) return
        const data = await response.json()
        const nextStatus = data?.status

        if (!cancelled && nextStatus && nextStatus !== discountApprovalStatus) {
          setDiscountApprovalStatus(nextStatus)

          if (nextStatus === "approved") {
            toast({
              title: "Discount Approved",
              description: "You can now save or print the invoice.",
              variant: "default",
            })
          } else if (nextStatus === "denied") {
            toast({
              title: "Discount Denied",
              description: "Please adjust the discount or request again.",
              variant: "destructive",
            })
          }
        }
      } catch (error) {
        console.error("Failed to poll discount status:", error)
      }
    }

    pollStatus()
    const interval = setInterval(pollStatus, 4000)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [discountRequestId, discountApprovalStatus, toast])

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
    
    if (value.trim().length > 0) {
      const filtered = customers.filter(customer => {
        if (!customer.name || typeof customer.name !== 'string') {
          return false
        }
        return customer.name.toLowerCase().includes(value.toLowerCase())
      })
      
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
    
    if (value.trim().length > 0) {
      const filtered = customers.filter(customer => {
        if (!customer.phone || typeof customer.phone !== 'string') {
          return false
        }
        return customer.phone.includes(value)
      })
      
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
    setCustomerName(customer.name)
    setCustomerPhone(customer.phone)
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
    discountRequestId,
    discountApprovalStatus,
    total: invoice.total,
    taxAmount: invoice.taxAmount,
  })

  const handleSaveClick = () => {
    if (isDiscountBlocked) {
      toast({
        title: "Approval Required",
        description: "Discount must be approved before saving.",
        variant: "destructive",
      })
      return
    }
    if (onSave) {
      onSave(getUpdatedInvoice())
      onClose()
    }
  }

  const handleClose = () => {
    setPrintError(null)
    onClose()
  }

  /**
   * ✅ FIXED: Opens print dialog ONCE, but user can set copies in the dialog
   * Browser's native print dialog has a "copies" field where user can select how many
   */
  const handlePrintAndSave = async () => {
    setIsPrinting(true)
    setPrintError(null)

    try {
      if (isDiscountBlocked) {
        toast({
          title: "Approval Required",
          description: "Discount must be approved before printing.",
          variant: "destructive",
        })
        setIsPrinting(false)
        return
      }

      console.log('🖨️ Starting native print process...')
      
      if (!printRef.current) {
        throw new Error('Print reference not found')
      }

      const printContent = printRef.current.innerHTML
      const html = generatePrintHTML(printContent, paperSize, invoice.id || 'unknown')

      // ✅ Create hidden iframe for printing
      const printFrame = document.createElement('iframe')
      printFrame.style.cssText = `
        position: fixed;
        top: -9999px;
        left: -9999px;
        width: 0;
        height: 0;
        border: none;
        visibility: hidden;
      `
      document.body.appendChild(printFrame)

      // Wait for iframe to be ready
      await new Promise(resolve => setTimeout(resolve, 100))

      const frameDoc = printFrame.contentDocument || printFrame.contentWindow?.document
      if (!frameDoc) {
        throw new Error('Failed to access iframe document')
      }

      // Write HTML to iframe
      frameDoc.open()
      frameDoc.write(html)
      frameDoc.close()

      // Wait for content to load
      await new Promise(resolve => {
        if (frameDoc.readyState === 'complete') {
          resolve(null)
        } else {
          printFrame.onload = () => resolve(null)
        }
      })

      console.log('📄 Print content ready')

      // ✅ Call print() ONCE - user sets copies in the dialog
      const printWindow = printFrame.contentWindow
      if (!printWindow) {
        throw new Error('Failed to access iframe window')
      }

      console.log('🖨️ Opening print dialog')
      printWindow.focus()
      printWindow.print()

      // Clean up iframe after a delay
      setTimeout(() => {
        if (document.body.contains(printFrame)) {
          document.body.removeChild(printFrame)
          console.log('🧹 Print frame cleaned up')
        }
      }, 2000)

      console.log('✅ Print dialog opened successfully')

      // Save the invoice after successful print
      if (onPrintAndSave) {
        console.log('💾 Saving invoice...')
        onPrintAndSave(getUpdatedInvoice())
      }

      // Close dialog
      handleClose()
    } catch (error) {
      console.error('❌ Print error:', error)
      setPrintError(error instanceof Error ? error.message : 'Unknown print error')
    } finally {
      setIsPrinting(false)
    }
  }

  const isThermal = paperSize.includes("Thermal")
  const isA4 = paperSize === "A4"
  const isLetter = paperSize === "Letter"
  const requiresDiscountApproval = invoice.discountPercentage > 10
  const isDiscountPending = requiresDiscountApproval && discountApprovalStatus === "pending"
  const isDiscountDenied = requiresDiscountApproval && discountApprovalStatus === "denied"
  const isDiscountBlocked = requiresDiscountApproval && discountApprovalStatus !== "approved"
  const discountStatusLabel =
    discountApprovalStatus === "approved"
      ? "Approved"
      : discountApprovalStatus === "denied"
      ? "Denied"
      : "Pending Approval"
  const discountStatusClass =
    discountApprovalStatus === "approved"
      ? "border-green-200 bg-green-50 text-green-800"
      : discountApprovalStatus === "denied"
      ? "border-red-200 bg-red-50 text-red-800"
      : "border-amber-200 bg-amber-50 text-amber-800"

  return (
    <Dialog open={isOpen} modal={false} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent showOverlay={false} className="max-w-7xl max-h-[95vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-2xl font-bold">Invoice Preview</DialogTitle>
          <DialogDescription>
            Review and customize your invoice before printing or saving
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 py-4">
          {/* Left Column: Edit Options */}
          <div className="lg:col-span-1 space-y-4">
            {/* Customer Information */}
            <div className="space-y-3">
              <h3 className="font-semibold text-lg flex items-center">
                <User className="h-4 w-4 mr-2" />
                Customer Details
              </h3>
              
              {/* Customer Name with Autocomplete */}
              <div ref={nameInputRef} className="relative">
                <Label htmlFor="customerName">Customer Name</Label>
                <Input
                  id="customerName"
                  value={customerName}
                  onChange={(e) => handleNameChange(e.target.value)}
                  onFocus={() => {
                    if (customerName.trim() && filteredCustomers.length > 0) {
                      setShowNameSuggestions(true)
                    }
                  }}
                  placeholder="Enter customer name"
                  className="w-full"
                />
                
                {/* Autocomplete Dropdown for Name */}
                {showNameSuggestions && filteredCustomers.length > 0 && (
                  <div className="absolute z-50 w-full mt-1 bg-white border border-gray-300 rounded-md shadow-lg max-h-48 overflow-y-auto">
                    {filteredCustomers.map((customer) => (
                      <div
                        key={customer.id}
                        onClick={() => selectCustomer(customer)}
                        className="px-4 py-2 hover:bg-gray-100 cursor-pointer flex justify-between items-center"
                      >
                        <span className="font-medium">{customer.name}</span>
                        <span className="text-sm text-gray-500">{customer.phone}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Customer Phone with Autocomplete */}
              <div ref={phoneInputRef} className="relative">
                <Label htmlFor="customerPhone">Customer Phone</Label>
                <Input
                  id="customerPhone"
                  value={customerPhone}
                  onChange={(e) => handlePhoneChange(e.target.value)}
                  onFocus={() => {
                    if (customerPhone.trim() && filteredCustomers.length > 0) {
                      setShowPhoneSuggestions(true)
                    }
                  }}
                  placeholder="Enter phone number"
                  className="w-full"
                />
                
                {/* Autocomplete Dropdown for Phone */}
                {showPhoneSuggestions && filteredCustomers.length > 0 && (
                  <div className="absolute z-50 w-full mt-1 bg-white border border-gray-300 rounded-md shadow-lg max-h-48 overflow-y-auto">
                    {filteredCustomers.map((customer) => (
                      <div
                        key={customer.id}
                        onClick={() => selectCustomer(customer)}
                        className="px-4 py-2 hover:bg-gray-100 cursor-pointer flex justify-between items-center"
                      >
                        <span className="font-medium">{customer.phone}</span>
                        <span className="text-sm text-gray-500">{customer.name}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Payment Method */}
            <div className="space-y-3">
              <h3 className="font-semibold text-lg flex items-center">
                <CreditCard className="h-4 w-4 mr-2" />
                Payment Method
              </h3>
              <Select value={paymentMethod} onValueChange={setPaymentMethod}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Cash">Cash</SelectItem>
                  <SelectItem value="UPI">UPI</SelectItem>
                  <SelectItem value="Card">Card</SelectItem>
                  <SelectItem value="Credit">Credit</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Paper Size */}
            <div className="space-y-3">
              <h3 className="font-semibold text-lg flex items-center">
                <Printer className="h-4 w-4 mr-2" />
                Paper Size
              </h3>
              <Select value={paperSize} onValueChange={setPaperSize}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Thermal 80mm">Thermal 80mm</SelectItem>
                  <SelectItem value="Thermal 58mm">Thermal 58mm</SelectItem>
                  <SelectItem value="A4">A4</SelectItem>
                  <SelectItem value="Letter">Letter</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {requiresDiscountApproval && (
              <div className={`rounded-md border px-4 py-3 ${discountStatusClass}`}>
                <div className="text-sm font-semibold">Discount Approval</div>
                <div className="text-sm">Status: {discountStatusLabel}</div>
                {isDiscountPending && (
                  <div className="text-xs mt-1">Waiting for approval. You can keep working in other tabs.</div>
                )}
                {isDiscountDenied && (
                  <div className="text-xs mt-1">Please reduce the discount or request approval again.</div>
                )}
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
            disabled={isPrinting || isDiscountBlocked}
          >
            <Printer className="h-4 w-4 mr-2" />
            {isPrinting ? "Processing..." : "Print & Save"}
          </Button>

          {onSave && (
            <Button onClick={handleSaveClick} variant="outline" disabled={isPrinting || isDiscountBlocked}>
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
                Opening print dialog...
              </div>
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * ✅ Generate print HTML with CSS to suggest default copies
 * Note: Not all browsers support CSS copies, so user may need to set in dialog
 */
function generatePrintHTML(printContent: string, paperSize: string, invoiceId: string): string {
  const getPageStyles = (): string => {
    if (paperSize === "Thermal 58mm") {
      return `
        @page {
          size: 58mm auto;
          margin: 0;
        }
        body {
          width: 58mm;
          margin: 0;
          padding: 2mm;
        }
      `
    } else if (paperSize === "Thermal 80mm") {
      return `
        @page {
          size: 80mm auto;
          margin: 0;
        }
        body {
          width: 80mm;
          margin: 0;
          padding: 2mm;
        }
      `
    } else if (paperSize === "A4") {
      return `
        @page {
          size: A4 portrait;
          margin: 0;
        }
        body {
          margin: 0;
          padding: 15mm 10mm;
        }
      `
    } else if (paperSize === "Letter") {
      return `
        @page {
          size: Letter portrait;
          margin: 0;
        }
        body {
          margin: 0;
          padding: 0.6in 0.4in;
        }
      `
    }
    return `
      @page {
        size: A4 portrait;
        margin: 0;
      }
      body {
        margin: 0;
        padding: 15mm 10mm;
      }
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
            font-family: 'Courier New', monospace;
            font-size: ${paperSize.includes("Thermal") ? "12px" : "14px"};
            line-height: 1.5;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
            background: white;
            color: black;
          }
          
          @media print {
            html, body {
              margin: 0 !important;
              overflow: visible !important;
              height: auto !important;
            }
            
            /* Remove default browser headers/footers */
            @page {
              margin: 0;
            }
            
            .no-print { 
              display: none !important; 
            }
          }
          
          .print-container {
            width: 100%;
            max-width: 100%;
            padding: 0;
            margin: 0 auto;
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
