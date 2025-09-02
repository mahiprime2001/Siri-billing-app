"use client"

import { forwardRef } from "react"
import { Gem } from "lucide-react"

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

interface PrintableInvoiceProps {
  invoice: Invoice
  paperSize: string
}

const PrintableInvoice = forwardRef<HTMLDivElement, PrintableInvoiceProps>(
  ({ invoice, paperSize }, ref) => {
    const isThermal = paperSize.includes("Thermal");

    // Safe number formatting function
    const formatNumber = (value: number | undefined | null): string => {
      if (value === null || value === undefined || isNaN(value)) {
        return "0";
      }
      return value.toLocaleString();
    };

    // Safe access to invoice properties with defaults
    const safeInvoice = {
      ...invoice,
      subtotal: invoice.subtotal || 0,
      total: invoice.total || 0,
      discountPercentage: invoice.discountPercentage || 0,
      discountAmount: invoice.discountAmount || 0,
      taxAmount: invoice.taxAmount || 0,
      items: (invoice.items || []).map((item) => ({
        ...item,
        price: item.price || 0,
        total: item.total || 0,
        quantity: item.quantity || 0,
      })),
    };

  const thermalStyles = {
    width: paperSize === "Thermal 58mm" ? "58mm" : "80mm",
    maxWidth: paperSize === "Thermal 58mm" ? "58mm" : "80mm",
    fontSize: paperSize === "Thermal 58mm" ? "10px" : "11px",
    lineHeight: paperSize === "Thermal 58mm" ? "1.2" : "1.3",
    fontFamily: "Courier New, monospace",
    padding: "2mm",
    margin: "0",
    color: "#000",
    backgroundColor: "#fff",
  }

  const standardStyles = {
    width: "100%",
    maxWidth: "100%",
    minHeight: paperSize === "A4" ? "250mm" : "10in", // Reduced to account for margins
    fontSize: "11px", // Slightly smaller to fit better
    lineHeight: "1.3",
    padding: "0", // Remove padding since page margins handle spacing
    margin: "0",
    color: "#000",
    backgroundColor: "#fff",
    boxSizing: "border-box" as const,
  }

  return (
    <div ref={ref} style={isThermal ? thermalStyles : standardStyles}>
      {isThermal ? (
        // Thermal Receipt Layout
        <div>
          {/* Header */}
          <div style={{ textAlign: "center", marginBottom: "8px" }}>
            <div style={{ fontSize: "14px", fontWeight: "bold" }}>
              {(safeInvoice.companyName || "Siri Art Jewellers").toUpperCase()}
            </div>
            <div style={{ fontSize: "12px" }}>
              {safeInvoice.companyAddress || "123 Jewelry Street"}
            </div>
            <div style={{ fontSize: "12px" }}>
              Ph: {safeInvoice.companyPhone || "+91 98765 43210"}
            </div>
            <div style={{ fontSize: "12px" }}>
              {safeInvoice.companyEmail || "info@siriartjewellers.com"}
            </div>
            <div style={{ fontSize: "12px" }}>
              GSTIN: {safeInvoice.gstin || "27ABCDE1234F1Z5"}
            </div>
            <div
              style={{
                borderTop: "1px dashed #000",
                margin: "4px 0",
              }}
            ></div>
            <div style={{ fontSize: "12px", fontWeight: "bold" }}>
              TAX INVOICE
            </div>
          </div>

          {/* Invoice Info */}
          <div style={{ fontSize: "12px", marginBottom: "8px" }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Invoice: {safeInvoice.id || "N/A"}</span>
              <span>
                {safeInvoice.timestamp
                  ? new Date(safeInvoice.timestamp).toLocaleDateString()
                  : "N/A"}
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Time: {new Date().toLocaleTimeString()}</span>
              <span>Payment: {safeInvoice.paymentMethod || "Cash"}</span>
            </div>
          </div>

          {/* Customer Info */}
          {(safeInvoice.customerName !== "Walk-in Customer" || safeInvoice.customerPhone) && (
            <div style={{ fontSize: "12px", marginBottom: "8px" }}>
              <div style={{ borderTop: "1px dashed #000", margin: "4px 0" }}></div>
              <div>Customer: {safeInvoice.customerName || "Walk-in Customer"}</div>
              {safeInvoice.customerPhone && <div>Phone: {safeInvoice.customerPhone}</div>}
              <div style={{ borderTop: "1px dashed #000", margin: "4px 0" }}></div>
            </div>
          )}

          {/* Items */}
          <div style={{ fontSize: "12px", marginBottom: "8px" }}>
            {safeInvoice.items.map((item, index) => (
              <div key={item.id || index} style={{ marginBottom: "4px" }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ flex: 1 }}>
                    {item.name || "Unknown Item"}
                  </span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>
                    {item.quantity} x ₹{formatNumber(item.price)}
                  </span>
                  <span>₹{formatNumber(item.total)}</span>
                </div>
                {index < safeInvoice.items.length - 1 && (
                  <div
                    style={{ borderTop: "1px dotted #000", margin: "2px 0" }}
                  ></div>
                )}
              </div>
            ))}
          </div>

          {/* Totals */}
          <div style={{ fontSize: "12px" }}>
            <div style={{ borderTop: "1px dashed #000", margin: "4px 0" }}></div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Subtotal:</span>
              <span>₹{formatNumber(safeInvoice.subtotal)}</span>
            </div>
            {safeInvoice.discountPercentage > 0 && (
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Discount ({safeInvoice.discountPercentage}%):</span>
                <span>-₹{formatNumber(safeInvoice.discountAmount)}</span>
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Tax ({safeInvoice.taxPercentage}%):</span>
              <span>₹{formatNumber(safeInvoice.taxAmount)}</span>
            </div>
            <div style={{ borderTop: "1px dashed #000", margin: "4px 0" }}></div>
            <div style={{ display: "flex", justifyContent: "space-between", fontWeight: "bold", fontSize: "14px" }}>
              <span>TOTAL:</span>
              <span>₹{formatNumber(safeInvoice.total)}</span>
            </div>
            <div style={{ borderTop: "1px dashed #000", margin: "4px 0" }}></div>
          </div>

          {/* Footer */}
          <div style={{ textAlign: "center", fontSize: "12px", marginTop: "8px" }}>
            <div>Thank you for your business!</div>
            <div>This is a computer generated invoice</div>
            <div style={{ marginTop: "4px" }}>{new Date().toLocaleString()}</div>
          </div>
        </div>
      ) : (
        // Standard A4/Letter Layout
        <div>
          {/* Header */}
          <div
            style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "20px" }} // Reduced from 32px
          >
            <div style={{ display: "flex", alignItems: "center" }}>
              <div
                style={{
                  padding: "12px",
                  backgroundColor: "#fef3c7",
                  borderRadius: "50%",
                  marginRight: "12px",
                }}
              >
                <Gem style={{ height: "32px", width: "32px", color: "#d97706" }} />
              </div>
              <div>
                <h1
                  style={{ fontSize: "24px", fontWeight: "bold", margin: "0 0 4px 0" }}
                >
                  {safeInvoice.companyName}
                </h1>
                <p style={{ margin: "2px 0", color: "#666" }}>
                  {safeInvoice.companyAddress}
                </p>
                <p style={{ margin: "2px 0", fontSize: "14px", color: "#666" }}>
                  Phone: {safeInvoice.companyPhone} | Email:{" "}
                  {safeInvoice.companyEmail}
                </p>
                <p style={{ margin: "2px 0", fontSize: "14px", color: "#666" }}>
                  GSTIN: {safeInvoice.gstin}
                </p>
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <h2
                style={{ fontSize: "20px", fontWeight: "bold", margin: "0 0 4px 0" }}
              >
                TAX INVOICE
              </h2>
              <p style={{ margin: "2px 0", color: "#666" }}>
                #{safeInvoice.id || "N/A"}
              </p>
              <p style={{ margin: "2px 0", fontSize: "14px", color: "#666" }}>
                Date:{" "}
                {safeInvoice.timestamp
                  ? new Date(safeInvoice.timestamp).toLocaleDateString()
                  : "N/A"}
              </p>
              <p style={{ margin: "2px 0", fontSize: "14px", color: "#666" }}>
                Payment: {safeInvoice.paymentMethod || "Cash"}
              </p>
            </div>
          </div>

          {/* Customer Information */}
          <div style={{ marginBottom: "20px" }}>
            {" "}
            {/* Customer Information section */}
            <h3 style={{ fontSize: "18px", fontWeight: "600", marginBottom: "8px" }}>Bill To:</h3>
            <div>
              <p style={{ fontWeight: "500", margin: "2px 0" }}>{safeInvoice.customerName || "Walk-in Customer"}</p>
              {safeInvoice.customerPhone && <p style={{ margin: "2px 0" }}>{safeInvoice.customerPhone}</p>}
            </div>
          </div>

          {/* Items Table */}
          <div style={{ marginBottom: "20px" }}>
            {" "}
            {/* Items Table section */}
            <table style={{ width: "100%", borderCollapse: "collapse", border: "1px solid #000" }}>
              <thead>
                <tr style={{ backgroundColor: "#f5f5f5" }}>
                  <th style={{ border: "1px solid #000", padding: "8px", textAlign: "left", fontWeight: "bold" }}>
                    Item
                  </th>
                  <th style={{ border: "1px solid #000", padding: "8px", textAlign: "right", fontWeight: "bold" }}>
                    Price
                  </th>
                  <th style={{ border: "1px solid #000", padding: "8px", textAlign: "right", fontWeight: "bold" }}>
                    Qty
                  </th>
                  <th style={{ border: "1px solid #000", padding: "8px", textAlign: "right", fontWeight: "bold" }}>
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {safeInvoice.items.map((item, index) => (
                  <tr key={item.id || index}>
                    <td style={{ border: "1px solid #000", padding: "8px" }}>
                      {item.name || "Unknown Item"}
                    </td>
                    <td
                      style={{
                        border: "1px solid #000",
                        padding: "8px",
                        textAlign: "right",
                      }}
                    >
                      ₹{formatNumber(item.price)}
                    </td>
                    <td
                      style={{
                        border: "1px solid #000",
                        padding: "8px",
                        textAlign: "right",
                      }}
                    >
                      {item.quantity}
                    </td>
                    <td
                      style={{
                        border: "1px solid #000",
                        padding: "8px",
                        textAlign: "right",
                      }}
                    >
                      ₹{formatNumber(item.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Totals */}
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "20px" }}>
            {" "}
            {/* Totals section */}
            <div style={{ width: "256px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0" }}>
                <span>Subtotal:</span>
                <span>₹{formatNumber(safeInvoice.subtotal)}</span>
              </div>
              {safeInvoice.discountPercentage > 0 && (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    padding: "8px 0",
                  }}
                >
                  <span>Discount ({safeInvoice.discountPercentage}%):</span>
                  <span>-₹{formatNumber(safeInvoice.discountAmount)}</span>
                </div>
              )}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "8px 0",
                }}
              >
                <span>Tax ({safeInvoice.taxPercentage}%):</span>
                <span>₹{formatNumber(safeInvoice.taxAmount)}</span>
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "8px 0",
                  borderTop: "1px solid #000",
                  fontWeight: "bold",
                  fontSize: "18px",
                }}
              >
                <span>Total Amount:</span>
                <span>₹{formatNumber(safeInvoice.total)}</span>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div
            style={{
              textAlign: "center",
              fontSize: "14px",
              color: "#666",
              borderTop: "1px solid #ccc",
              paddingTop: "16px",
            }}
          >
            <p style={{ margin: "2px 0" }}>Thank you for your business!</p>
            <p style={{ margin: "2px 0" }}>This is a computer generated tax invoice</p>
            <p style={{ margin: "2px 0" }}>
              For any queries, please contact us at {safeInvoice.companyEmail}
            </p>
          </div>
        </div>
      )}
    </div>
  )
})

PrintableInvoice.displayName = "PrintableInvoice"

export default PrintableInvoice
