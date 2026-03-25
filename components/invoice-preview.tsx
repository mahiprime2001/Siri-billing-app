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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Save, Printer, AlertCircle, User, CreditCard } from "lucide-react"
import PrintableInvoice from "./printable-invoice"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useToast } from "@/components/ui/use-toast"
import { apiClient } from "@/lib/api-client"
import { isTauriApp, listPrinters, printHtmlContent } from "@/lib/tauriPrinter"
import { safePrint } from "@/lib/printUtils"
import { getThermalConfig, measureContentScale } from "@/utils/printCalibration"


interface InvoicePreviewProps {
  invoice: Invoice
  isOpen: boolean
  onClose: () => void
  onSave?: (updatedInvoice: Invoice) => void | boolean | Invoice | Promise<void | boolean | Invoice>
  onPrintAndSave?: (updatedInvoice: Invoice) => void | boolean | Invoice | Promise<void | boolean | Invoice>
  onUpdateInvoice?: (updatedInvoice: Invoice) => void
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
  onUpdateInvoice,
  initialPaperSize = "Thermal 80mm",
  initialCustomerName = "Walk-in Customer",
  initialCustomerPhone = "",
  initialPaymentMethod = "Cash",
}: InvoicePreviewProps) {
  const SYSTEM_DEFAULT_PRINTER_VALUE = "__SYSTEM_DEFAULT__"
  const PRINTER_STORAGE_KEY = "siri_selected_printer"
  const printRef = useRef<HTMLDivElement>(null)
  const nameInputRef = useRef<HTMLDivElement>(null)
  const phoneInputRef = useRef<HTMLDivElement>(null)
  const { toast } = useToast()
  
  const [isPrinting, setIsPrinting] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [printError, setPrintError] = useState<string | null>(null)
  const [discountApprovalStatus, setDiscountApprovalStatus] = useState<Invoice["discountApprovalStatus"]>(
    invoice.discountApprovalStatus || "not_required"
  )
  const [discountRequestId, setDiscountRequestId] = useState<string | undefined>(invoice.discountRequestId)
  const [otpValue, setOtpValue] = useState("")
  const [isVerifyingOtp, setIsVerifyingOtp] = useState(false)

  // Editable states
  const [customerName, setCustomerName] = useState(initialCustomerName)
  const [customerPhone, setCustomerPhone] = useState(initialCustomerPhone)
  const [paymentMethod, setPaymentMethod] = useState(initialPaymentMethod)
  const [paperSize, setPaperSize] = useState(initialPaperSize)
  const [printers, setPrinters] = useState<string[]>([])
  const [selectedPrinter, setSelectedPrinter] = useState<string>(SYSTEM_DEFAULT_PRINTER_VALUE)
  const [isLoadingPrinters, setIsLoadingPrinters] = useState(false)

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
    setOtpValue("")
  }, [invoice.discountApprovalStatus, invoice.discountRequestId])

  useEffect(() => {
    if (typeof window === "undefined") return
    const saved = window.localStorage.getItem(PRINTER_STORAGE_KEY)
    if (saved?.trim()) {
      setSelectedPrinter(saved)
    } else {
      setSelectedPrinter(SYSTEM_DEFAULT_PRINTER_VALUE)
    }
  }, [])

  useEffect(() => {
    if (!isOpen || !isTauriApp()) return
    let cancelled = false

    const fetchPrinters = async () => {
      setIsLoadingPrinters(true)
      try {
        const names = await listPrinters()
        if (!cancelled) {
          setPrinters(names)
          setSelectedPrinter((prev) =>
            prev !== SYSTEM_DEFAULT_PRINTER_VALUE && prev && !names.includes(prev) ? SYSTEM_DEFAULT_PRINTER_VALUE : prev,
          )
        }
      } finally {
        if (!cancelled) {
          setIsLoadingPrinters(false)
        }
      }
    }

    fetchPrinters()
    return () => {
      cancelled = true
    }
  }, [isOpen])

  useEffect(() => {
    if (typeof window === "undefined") return
    window.localStorage.setItem(PRINTER_STORAGE_KEY, selectedPrinter)
  }, [selectedPrinter])

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
          onUpdateInvoice?.({ ...invoice, discountApprovalStatus: nextStatus })

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

  const handleVerifyOtp = async () => {
    if (!requiresDiscountApproval) {
      toast({
        title: "No Approval Needed",
        description: "OTP verification is only required for discounts above 10%.",
      })
      return
    }

    if (!otpValue.trim()) {
      toast({
        title: "OTP Required",
        description: "Enter the 2FA code to verify the discount.",
        variant: "destructive",
      })
      return
    }

    try {
      setIsVerifyingOtp(true)
      const response = await apiClient("/api/discounts/verify-otp", {
        method: "POST",
        body: JSON.stringify({
          otp: otpValue.trim(),
          discount_percentage: invoice.discountPercentage,
          discount_amount: invoice.discountAmount,
          defer_persist: true,
        }),
      })

      const payload = await response.json().catch(() => ({}))

      if (!response.ok) {
        toast({
          title: "OTP Failed",
          description: payload?.message || "Could not verify the OTP.",
          variant: "destructive",
        })
        return
      }

      setDiscountApprovalStatus("approved")
      setOtpValue("")
      const updated = { ...getUpdatedInvoice(), discountApprovalStatus: "approved" as const }
      onUpdateInvoice?.(updated)

      toast({
        title: "Discount Approved",
        description: "OTP verified. You can now save or print the invoice.",
        variant: "default",
      })
    } catch (error: any) {
      toast({
        title: "Verification Error",
        description: error?.message || "Unable to verify OTP right now.",
        variant: "destructive",
      })
    } finally {
      setIsVerifyingOtp(false)
    }
  }

  const handleSaveClick = async () => {
    if (isSaving) return
    if (isDiscountBlocked) {
      toast({
        title: "Approval Required",
        description: "Discount must be approved before saving.",
        variant: "destructive",
      })
      return
    }
    if (!onSave) return
    setIsSaving(true)
    try {
      const result = await Promise.resolve(onSave(getUpdatedInvoice()))
      if (result !== false) {
        onClose()
      }
    } finally {
      setIsSaving(false)
    }
  }

  const handleClose = () => {
    setPrintError(null)
    onClose()
  }

  /**
   * ✅ Uses native Tauri printing when available; browser dialog otherwise
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

      const updatedInvoice = getUpdatedInvoice()

      // Save first so print always uses the real persisted invoice number.
      if (onPrintAndSave) {
        console.log('💾 Saving invoice...')
        const saveResult = await Promise.resolve(onPrintAndSave(updatedInvoice))
        if (saveResult === false) {
          setIsPrinting(false)
          return
        }
        if (saveResult && typeof saveResult === "object") {
          Object.assign(updatedInvoice, saveResult)
        }
      }

      onUpdateInvoice?.(updatedInvoice)
      await new Promise((resolve) => setTimeout(resolve, 0))

      console.log('🖨️ Starting print process...')
      if (!printRef.current) {
        throw new Error('Print reference not found')
      }

      const printableInvoiceId = updatedInvoice.id || invoice.id || 'unknown'
      const printContent = printRef.current.outerHTML
      const config = getThermalConfig(paperSize)

      let scale = 1
      if (printRef.current && paperSize.includes("Thermal")) {
        scale = measureContentScale(printRef.current, config.maxWidthPx)
      }

      const html = generatePrintHTML(
        printContent,
        paperSize,
        printableInvoiceId,
        scale,
        config
      )

      if (isTauriApp()) {
        const printerName = selectedPrinter === SYSTEM_DEFAULT_PRINTER_VALUE ? "" : selectedPrinter
        const result = await printHtmlContent(html, { paperSize, printerName, copies: 2 }) // this is place where to put the no of copies required for the print.
        console.log('✅ Tauri print submitted:', result)
        toast({
          title: "Print job queued",
          description: `Printer: ${printerName || "System default"}`,
          variant: "default",
        })
      } else {
        const result = await safePrint(html, paperSize)
        if (!result.success) {
          throw new Error(result.error || 'Browser print failed')
        }
        console.log('✅ Browser print dialog opened')
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
  const hiddenPrintWidthPx = isThermal ? (paperSize === "Thermal 58mm" ? "200px" : "270px") : "840px"
  const requiresDiscountApproval = invoice.discountPercentage > 10
  const isDiscountApproved = requiresDiscountApproval && discountApprovalStatus === "approved"
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
    <Sheet open={isOpen} modal={false} onOpenChange={(open) => !open && handleClose()}>
      <SheetContent
        side="left"
        showOverlay={false}
        className="!w-[98vw] sm:!w-[96vw] lg:!w-[52vw] !max-w-none sm:!max-w-none overflow-y-auto p-4 sm:p-6"
      >
        <SheetHeader>
          <SheetTitle className="text-2xl font-bold">Invoice Preview</SheetTitle>
          <SheetDescription>
            Review and customize your invoice before printing or saving
          </SheetDescription>
        </SheetHeader>

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

            <div className="space-y-3">
              <h3 className="font-semibold text-lg flex items-center">
                <Printer className="h-4 w-4 mr-2" />
                Printer
              </h3>
              <Select
                value={selectedPrinter}
                onValueChange={setSelectedPrinter}
                disabled={!isTauriApp() || isLoadingPrinters}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      !isTauriApp()
                        ? "Available in desktop app"
                        : isLoadingPrinters
                        ? "Loading printers..."
                        : "Select printer"
                    }
                  />
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
            </div>

            {requiresDiscountApproval && (
              <div className={`rounded-md border px-4 py-3 space-y-3 ${discountStatusClass}`}>
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold">Discount Approval</div>
                  <div className="text-xs font-medium px-2 py-1 rounded-full border">{discountStatusLabel}</div>
                </div>

                {isDiscountApproved ? (
                  <div className="text-sm font-medium">Discount is approved.</div>
                ) : (
                  <div className="space-y-1">
                    <Label htmlFor="discount-otp" className="text-xs uppercase tracking-wide">
                      OTP
                    </Label>
                    <div className="flex gap-2">
                      <Input
                        id="discount-otp"
                        value={otpValue}
                        onChange={(e) => setOtpValue(e.target.value)}
                        placeholder="Enter 2FA code"
                        className="text-sm"
                        inputMode="numeric"
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                      />
                      <Button type="button" onClick={handleVerifyOtp} disabled={isVerifyingOtp}>
                        {isVerifyingOtp ? "Verifying..." : "Verify"}
                      </Button>
                    </div>
                    <p className="text-[11px] text-gray-700">
                      Enter the 2FA code to approve this discount. The discount is saved only when the bill is saved.
                    </p>
                  </div>
                )}

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
            {/* FIX Risk 6: position offscreen instead of display:none.
                display:none causes IE/WebBrowser to capture a zero-height
                collapsed layout. Moving it offscreen keeps it fully rendered. */}
            <div style={{
              position: "fixed",
              top: 0,
              left: "-9999px",
              width: hiddenPrintWidthPx,
              visibility: "hidden",
              pointerEvents: "none",
              zIndex: -1,
            }}>
              <PrintableInvoice ref={printRef} invoice={getUpdatedInvoice()} paperSize={paperSize} />
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <SheetFooter className="flex justify-center sm:justify-center space-x-4 mt-4">
          <Button
            onClick={handlePrintAndSave}
            className={`bg-blue-600 hover:bg-blue-700 ${isPrinting ? "animate-pulse" : ""}`}
            disabled={isPrinting || isSaving || isDiscountBlocked}
          >
            {isPrinting ? (
              <span className="inline-flex items-center">
                <span className="mr-2 inline-flex items-center">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"></span>
                </span>
                Printing...
              </span>
            ) : (
              <>
                <Printer className="h-4 w-4 mr-2" />
                {isSaving ? "Saving..." : "Print & Save"}
              </>
            )}
          </Button>

          {onSave && (
            <Button onClick={handleSaveClick} variant="outline" disabled={isPrinting || isSaving || isDiscountBlocked}>
              <Save className="h-4 w-4 mr-2" />
              {isSaving ? "Saving..." : "Save Only"}
            </Button>
          )}

          <Button variant="outline" onClick={handleClose} disabled={isPrinting || isSaving}>
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
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

/**
 * ✅ Generate print HTML with CSS to suggest default copies
 * Note: Not all browsers support CSS copies, so user may need to set in dialog
 */
function generatePrintHTML(
  printContent: string,
  paperSize: string,
  invoiceId: string,
  scale: number = 1,
  config?: any
): string {
  const getPageStyles = (): string => {
    if (paperSize === "Thermal 80mm") {
      return `
        @page {
          size: 80mm auto;
          margin: 0;
        }

        html, body {
          width: 100%;
          margin: 0;
          padding: 0;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }

        body {
          display: block;
        }

        .print-container {
          width: 100%;
          max-width: ${config?.maxWidthMM || 72}mm;
          margin: 0 auto;
          padding-left: ${config?.sideMarginCompensationPx || 4}px;
          padding-right: ${config?.sideMarginCompensationPx || 4}px;
          box-sizing: border-box;
          zoom: ${scale};
        }
      `
    }

    if (paperSize === "Thermal 58mm") {
      return `
        @page {
          size: 58mm auto;
          margin: 0;
        }

        html, body {
          width: 100%;
          margin: 0;
          padding: 0;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }

        body {
          display: block;
        }

        .print-container {
          width: 100%;
          max-width: ${config?.maxWidthMM || 48}mm;
          margin: 0 auto;
          padding-left: ${config?.sideMarginCompensationPx || 3}px;
          padding-right: ${config?.sideMarginCompensationPx || 3}px;
          box-sizing: border-box;
          zoom: ${scale};
        }
      `
    }

    if (paperSize === "A4") {
      return `
        @page { size: A4 portrait; margin: 0; }
        body { margin: 0; padding: 15mm 10mm; }
      `
    }

    if (paperSize === "Letter") {
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
    <html>
      <head>
        <meta charset="UTF-8" />
        <title>Invoice-${invoiceId}</title>

        <style>
          ${getPageStyles()}

          * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
          }

          body {
            font-family: 'Courier New', monospace;
            font-size: ${paperSize.includes("Thermal") ? "12px" : "14px"};
            line-height: 1.5;
            background: white;
            color: #000;
            font-weight: 600;
            text-rendering: geometricPrecision;
            -webkit-font-smoothing: antialiased;
          }

          @media print {
            @page { margin: 0; }
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
