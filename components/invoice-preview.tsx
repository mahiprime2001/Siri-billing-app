"use client"

import { useRef } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Download, Save, Printer } from "lucide-react"
import PrintableInvoice from "./printable-invoice"

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
  items: any[]; // You might want to define a proper type for items
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

  const handlePrint = () => {
    if (printRef.current) {
      // Create a new window for printing
      const printWindow = window.open("", "_blank")
      if (printWindow) {
        const printContent = printRef.current.innerHTML

        // Define margins based on paper size
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

        printWindow.document.write(`
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
              ${printContent}
            </body>
          </html>
        `)

        printWindow.document.close()
        printWindow.focus()

        // Wait for content to load then print
        setTimeout(() => {
          printWindow.print()
          printWindow.close()
        }, 250)
      }
    }
  }

  const handlePrintAndSave = async () => {
    if (onPrintAndSave) {
      await onPrintAndSave()
    }
    handlePrint()
  }

  const handlePrintOnly = () => {
    handlePrint()
  }

  const isThermal = paperSize.includes("Thermal")
  const isA4 = paperSize === "A4"
  const isLetter = paperSize === "Letter"

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
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
          {/* Invoice Preview */}
          <div className="bg-white mx-auto shadow-lg border rounded-lg overflow-hidden">
            <div className="p-4 bg-gray-50 border-b">
              <p className="text-sm text-gray-600">Preview - This is how your invoice will look when printed</p>
            </div>
            <div className="p-4 max-h-96 overflow-y-auto">
              <div
                className={`mx-auto ${
                  isThermal ? "max-w-sm" : isA4 ? "max-w-2xl" : isLetter ? "max-w-2xl" : "max-w-2xl"
                }`}
                style={{ transform: "scale(0.8)", transformOrigin: "top center" }}
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
            <Button onClick={handlePrintAndSave} className="bg-blue-600 hover:bg-blue-700">
              <Printer className="h-4 w-4 mr-2" />
              Print & Save
            </Button>

            {onSave && (
              <Button onClick={onSave} variant="outline">
                <Save className="h-4 w-4 mr-2" />
                Save Only
              </Button>
            )}

            <Button variant="outline" onClick={handlePrintOnly}>
              <Download className="h-4 w-4 mr-2" />
              Print Only
            </Button>

            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
