"use client"

import { useRef, useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Download, Save, Printer, AlertCircle } from "lucide-react"
import PrintableInvoice from "./printable-invoice"
import { safePrint } from "@/lib/printUtils"

interface Invoice {
  id: string;
  storeId: string;
  storeName: string;
  storeAddress: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  customerAddress: string;
  customerId: string;
  subtotal: number;
  taxPercentage: number;
  taxAmount: number;
  discountPercentage: number;
  discountAmount: number;
  total: number;
  paymentMethod: string;
  timestamp: string;
  notes: string;
  gstin: string;
  companyName: string;
  companyAddress: string;
  companyPhone: string;
  companyEmail: string;
  billFormat: string;
  createdBy: string;
  items: any[];
}

interface InvoicePreviewProps {
  invoice: Invoice
  isOpen: boolean
  onClose: () => void
  onSave?: () => void
  onPrintAndSave?: () => void
  paperSize?: string
}

export default function InvoicePreview({
  invoice,
  isOpen,
  onClose,
  onSave,
  onPrintAndSave,
  paperSize = "Thermal 80mm",
}: InvoicePreviewProps) {
  const printRef = useRef<HTMLDivElement>(null)
  const [isPrinting, setIsPrinting] = useState(false)
  const [printError, setPrintError] = useState<string | null>(null)

  const handlePrint = async () => {
    if (!printRef.current) {
      setPrintError("Print content not available. Please try again.")
      return
    }

    setIsPrinting(true)
    setPrintError(null)

    try {
      const printContent = printRef.current.innerHTML
      const htmlContent = generatePrintHTML(printContent, paperSize, invoice.id)

      console.log("🖨 [InvoicePreview] Starting print process...")
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
        await onPrintAndSave()
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
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Tax Invoice Preview - {invoice.id} ({paperSize})
          </DialogTitle>
          <DialogDescription>
            Review the invoice details before saving or printing.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
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

          {/* Invoice Preview */}
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
                    ? "w-[80mm]" // Set explicit width for 80mm thermal
                    : isThermal && paperSize === "Thermal 58mm"
                    ? "w-[58mm]" // Set explicit width for 58mm thermal
                    : isA4
                    ? "max-w-2xl"
                    : isLetter
                    ? "max-w-2xl"
                    : "max-w-2xl"
                }`}
                style={
                  isThermal
                    ? { transformOrigin: "top center" } // Remove scale for thermal, keep origin
                    : { transform: "scale(0.8)", transformOrigin: "top center" }
                }
              >
                <PrintableInvoice invoice={invoice} paperSize={paperSize} />
              </div>
            </div>
          </div>

          {/* Hidden Printable Component */}
          <div style={{ display: "none" }}>
            <PrintableInvoice ref={printRef} invoice={invoice} paperSize={paperSize} />
          </div>

          {/* Action Buttons */}
          <div className="flex justify-center space-x-4">
            <Button
              onClick={handlePrintAndSave}
              className="bg-blue-600 hover:bg-blue-700"
              disabled={isPrinting}
            >
              <Printer className="h-4 w-4 mr-2" />
              {isPrinting ? "Processing..." : "Print & Save"}
            </Button>

            {onSave && (
              <Button onClick={onSave} variant="outline" disabled={isPrinting}>
                <Save className="h-4 w-4 mr-2" />
                Save Only
              </Button>
            )}

            <Button variant="outline" onClick={handleClose} disabled={isPrinting}>
              Close
            </Button>
          </div>

          {/* Loading indicator */}
          {isPrinting && (
            <div className="text-center text-sm text-gray-600">
              <div className="inline-flex items-center">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600 mr-2"></div>
                Preparing print...
              </div>
            </div>
          )}
        </div>
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
          /* Actual printable width for 58mm paper is ~48mm */
          size: 58mm auto;
          margin: 1mm 2mm; /* small safe margin for most 58mm printers */
        }
        body {
          width: 48mm;
        }
      `
    } else if (paperSize === "Thermal 80mm") {
      return `
        @page {
          /* Actual printable width for 80mm paper is ~72mm */
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