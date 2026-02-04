"use client";
import React, { forwardRef } from "react";

interface PrintableInvoiceProps {
  invoice: Invoice;
  paperSize: string;
}

const PrintableInvoice = forwardRef<HTMLDivElement, PrintableInvoiceProps>(
  ({ invoice }, ref) => {
    const formatNumber = (value: number | undefined | null | string) => {
      if (value == null || isNaN(Number(value))) return 0;
      return Number(value).toLocaleString();
    };

    const pageWidth = "80mm";

    const safeInvoice = {
      ...invoice,
      subtotal: invoice.subtotal || 0,
      total: invoice.total || 0,
      discountPercentage: invoice.discountPercentage || 0,
      discountAmount: invoice.discountAmount || 0,
      cgst: invoice.cgst || 0,
      sgst: invoice.sgst || 0,
      taxAmount: invoice.taxAmount || 0,
      items:
        invoice.items?.map((item) => ({
          ...item,
          price: item.price || 0,
          total: item.total || 0,
          quantity: item.quantity || 0,
        })) || [],
    };

    const discountPercent = safeInvoice.discountPercentage || 0;

    const taxClassificationRows = safeInvoice.items.map((item) => {
      const itemTotal = Number(item.total || 0);
      const taxableAmount =
        Math.round((itemTotal - (itemTotal * discountPercent) / 100) * 100) / 100;
      const taxPercent = Number(item.taxPercentage || 0);
      const totalTax = Math.round((taxableAmount * taxPercent / 100) * 100) / 100;
      const cgst = Math.round((totalTax / 2) * 100) / 100;
      const sgst = Math.round((totalTax / 2) * 100) / 100;
      const hsnCode = item.hsnCode || item.hsn || item.hsn_code || "-";

      return {
        gst: taxPercent,
        hsnCode,
        cgst,
        sgst,
        taxableAmount,
      };
    });

    return (
      <>
        <div
          className="invoice-wrapper"
          ref={ref}
          style={{
            width: pageWidth,
            margin: "0 auto",
            padding: "0 2mm",
            boxSizing: "border-box",
            background: "#fff",
          }}
        >
          <div
            className="invoice-content"
            style={{
              width: "100%",
              fontSize: 12,
              lineHeight: 1.5,
              fontWeight: "bold",
              fontFamily: "Courier New, monospace",
              color: "#000",
            }}
          >
            {/* Header */}
            <div style={{ textAlign: "center", marginBottom: 6 }}>
              <div style={{ fontWeight: "bold", fontSize: 16 }}>
                {safeInvoice.companyName}
              </div>
              <div style={{ fontSize: 10 }}>
                {safeInvoice.storeAddress || safeInvoice.companyAddress}
              </div>
              <div style={{ fontSize: 10 }}>Ph: {safeInvoice.companyPhone}</div>
              <div style={{ fontSize: 10 }}>Email: {safeInvoice.companyEmail}</div>
              {safeInvoice.gstin && (
                <div style={{ fontSize: 10 }}>GSTIN: {safeInvoice.gstin}</div>
              )}
            </div>

            <hr style={{ border: "none", borderTop: "1px dashed #000" }} />

            {/* Invoice & Customer */}
            <div style={{ fontSize: 10, marginBottom: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Invoice #{safeInvoice.id}</span>
                <span>
                  {safeInvoice.timestamp
                    ? new Date(safeInvoice.timestamp).toLocaleDateString()
                    : ""}
                </span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Time: {new Date().toLocaleTimeString()}</span>
                <span>Payment: {safeInvoice.paymentMethod}</span>
              </div>
              <div>Customer: {safeInvoice.customerName}</div>
              {safeInvoice.customerPhone && (
                <div>Phone: {safeInvoice.customerPhone}</div>
              )}
              <div>Billed by: {safeInvoice.billedBy || "N/A"}</div>
            </div>

            <hr style={{ border: "none", borderTop: "1px dashed #000" }} />

            {/* Items */}
            <div style={{ fontSize: 10, marginBottom: 6 }}>
              {safeInvoice.items.map((item, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                  }}
                >
                  <span>{item.name}</span>
                  <span>
                    {item.quantity}×₹{formatNumber(item.price)}
                  </span>
                  <span>₹{formatNumber(item.total)}</span>
                </div>
              ))}
            </div>

            <hr style={{ border: "none", borderTop: "1px dashed #000" }} />

            {/* Totals */}
            <div style={{ fontSize: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Subtotal</span>
                <span>₹{formatNumber(safeInvoice.subtotal)}</span>
              </div>
            </div>

            {/* Tax Classification */}
            <div style={{ fontSize: 10, marginTop: 6 }}>
              <div style={{ fontWeight: "bold", marginBottom: 4 }}>
                Tax Classification
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr",
                  gap: 0,
                  fontWeight: "bold",
                  border: "1px solid #000",
                }}
              >
                <span style={{ padding: "2px 4px", borderRight: "1px solid #000" }}>GST</span>
                <span style={{ padding: "2px 4px", borderRight: "1px solid #000" }}>HSN Code</span>
                <span style={{ padding: "2px 4px", borderRight: "1px solid #000" }}>SGST</span>
                <span style={{ padding: "2px 4px", borderRight: "1px solid #000" }}>CGST</span>
                <span style={{ padding: "2px 4px" }}>Tax Amount</span>
              </div>
              {taxClassificationRows.map((row, index) => (
                <div
                  key={index}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr",
                    gap: 0,
                    borderLeft: "1px solid #000",
                    borderRight: "1px solid #000",
                    borderBottom: "1px solid #000",
                  }}
                >
                  <span style={{ padding: "2px 4px", borderRight: "1px solid #000" }}>
                    {row.gst}%
                  </span>
                  <span style={{ padding: "2px 4px", borderRight: "1px solid #000" }}>
                    {row.hsnCode}
                  </span>
                  <span style={{ padding: "2px 4px", borderRight: "1px solid #000" }}>
                    ₹{formatNumber(row.sgst)}
                  </span>
                  <span style={{ padding: "2px 4px", borderRight: "1px solid #000" }}>
                    ₹{formatNumber(row.cgst)}
                  </span>
                  <span style={{ padding: "2px 4px" }}>
                    ₹{formatNumber(row.taxableAmount)}
                  </span>
                </div>
              ))}
            </div>

            {/* Discount + Total */}
            <div style={{ fontSize: 10, marginTop: 6 }}>
              {safeInvoice.discountPercentage > 0 && (
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>Discount ({safeInvoice.discountPercentage}%)</span>
                  <span>-₹{formatNumber(safeInvoice.discountAmount)}</span>
                </div>
              )}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontWeight: "bold",
                  marginTop: 6,
                  fontSize: 14,
                }}
              >
                <span>TOTAL</span>
                <span>₹{formatNumber(safeInvoice.total)}</span>
              </div>
            </div>

            <hr style={{ border: "none", borderTop: "1px dashed #000", marginTop: 6 }} />

            {/* Footer */}
            <div style={{ textAlign: "center", fontSize: 10, marginTop: 6 }}>
              <div>This is a computer-generated invoice</div>
              
              {/* ✅ Savings Message - BOLD */}
              {safeInvoice.discountPercentage > 0 && safeInvoice.discountAmount > 0 && (
                <div style={{ fontWeight: "bold", marginTop: 4, marginBottom: 4 }}>
                  You have saved ₹{formatNumber(safeInvoice.discountAmount)} by shopping here!
                </div>
              )}
              
              {/* ✅ Thank You Message */}
              <div style={{ marginTop: 6 }}>
                <div style={{ fontWeight: "bold" }}>Thank You!</div>
                <div>Please visit us again</div>
              </div>
              
              <div style={{ marginTop: 4, fontSize: 9 }}>
                {new Date().toLocaleString()}
              </div>
            </div>
          </div>
        </div>

        <style jsx global>{`
          @page {
            size: 80mm auto;
            margin: 0;
          }
          body {
            margin: 0;
            padding: 0;
            -webkit-print-color-adjust: exact;
            background: #fff;
          }
        `}</style>
      </>
    );
  }
);

PrintableInvoice.displayName = "PrintableInvoice";
export default PrintableInvoice;
