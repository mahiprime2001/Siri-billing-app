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
      const taxableAmount = Math.round((itemTotal - (itemTotal * discountPercent) / 100) * 100) / 100;
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
        igst: 0,
        totalTax,
        taxableAmount,
      };
    });

    const totalCGST = taxClassificationRows.reduce((sum, row) => sum + row.cgst, 0);
    const totalSGST = taxClassificationRows.reduce((sum, row) => sum + row.sgst, 0);
    const totalTaxAmount = taxClassificationRows.reduce((sum, row) => sum + row.totalTax, 0);

    return (
      <>
        <div
          className="invoice-wrapper"
          ref={ref}
          style={{
            width: "100%",
            maxWidth: "80mm",
            margin: "0 auto",
            padding: "0",
            boxSizing: "border-box",
            background: "#fff",
          }}
        >
          <div
            className="invoice-content"
            style={{
              width: "100%",
              padding: "0 3mm",
              boxSizing: "border-box",
              fontSize: 11,
              lineHeight: 1.4,
              fontWeight: "bold",
              fontFamily: "Courier New, monospace",
              color: "#000",
            }}
          >
            {/* Header */}
            <div style={{ textAlign: "center", marginBottom: 5 }}>
              <div style={{ fontWeight: "bold", fontSize: 15 }}>
                {safeInvoice.companyName}
              </div>
              <div style={{ fontSize: 9 }}>
                {safeInvoice.storeAddress || safeInvoice.companyAddress}
              </div>
              <div style={{ fontSize: 9 }}>Ph: {safeInvoice.companyPhone}</div>
              <div style={{ fontSize: 9 }}>Email: {safeInvoice.companyEmail}</div>
              {safeInvoice.gstin && (
                <div style={{ fontSize: 9 }}>GSTIN: {safeInvoice.gstin}</div>
              )}
            </div>

            <div style={{ borderTop: "1px dashed #000", margin: "5px 0" }} />

            {/* Invoice & Customer */}
            <div style={{ fontSize: 9, marginBottom: 5 }}>
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

            <div style={{ borderTop: "1px dashed #000", margin: "5px 0" }} />

            {/* Items */}
            <div style={{ fontSize: 9, marginBottom: 5 }}>
              {safeInvoice.items.map((item, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginBottom: 2,
                  }}
                >
                  <span style={{ flex: 1 }}>{item.name}</span>
                  <span style={{ marginLeft: 5 }}>
                    {item.quantity}×₹{formatNumber(item.price)}
                  </span>
                  <span style={{ marginLeft: 5, minWidth: "50px", textAlign: "right" }}>
                    ₹{formatNumber(item.total)}
                  </span>
                </div>
              ))}
            </div>

            <div style={{ borderTop: "1px dashed #000", margin: "5px 0" }} />

            {/* Subtotal */}
            <div style={{ fontSize: 9 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Subtotal</span>
                <span>₹{formatNumber(safeInvoice.subtotal)}</span>
              </div>
            </div>

            {/* Tax Classification - NO BORDERS, using spacing and dashed lines */}
            <div style={{ fontSize: 8, marginTop: 6, marginBottom: 6 }}>
              <div style={{ fontWeight: "bold", marginBottom: 3, fontSize: 9 }}>
                Tax Classification
              </div>
              
              {/* Header Row */}
              <div style={{ 
                display: "flex", 
                justifyContent: "space-between",
                borderBottom: "1px dashed #000",
                paddingBottom: 2,
                marginBottom: 2
              }}>
                <span style={{ width: "12%", fontSize: 7 }}>GST%</span>
                <span style={{ width: "20%", fontSize: 7 }}>HSN</span>
                <span style={{ width: "17%", fontSize: 7, textAlign: "right" }}>SGST</span>
                <span style={{ width: "17%", fontSize: 7, textAlign: "right" }}>CGST</span>
                <span style={{ width: "15%", fontSize: 7, textAlign: "right" }}>IGST</span>
                <span style={{ width: "19%", fontSize: 7, textAlign: "right" }}>Tax</span>
              </div>
              
              {/* Data Rows */}
              {taxClassificationRows.map((row, index) => (
                <div
                  key={index}
                  style={{ 
                    display: "flex", 
                    justifyContent: "space-between",
                    marginBottom: 2
                  }}
                >
                  <span style={{ width: "12%", fontSize: 7 }}>{row.gst}%</span>
                  <span style={{ width: "20%", fontSize: 7 }}>{row.hsnCode}</span>
                  <span style={{ width: "17%", fontSize: 7, textAlign: "right" }}>₹{formatNumber(row.sgst)}</span>
                  <span style={{ width: "17%", fontSize: 7, textAlign: "right" }}>₹{formatNumber(row.cgst)}</span>
                  <span style={{ width: "15%", fontSize: 7, textAlign: "right" }}>₹{formatNumber(row.igst)}</span>
                  <span style={{ width: "19%", fontSize: 7, textAlign: "right" }}>₹{formatNumber(row.totalTax)}</span>
                </div>
              ))}
              
              {/* Total Row */}
              <div style={{ 
                display: "flex", 
                justifyContent: "space-between",
                borderTop: "1px dashed #000",
                paddingTop: 2,
                marginTop: 2,
                fontWeight: "bold"
              }}>
                <span style={{ width: "12%", fontSize: 7 }}>Total</span>
                <span style={{ width: "20%", fontSize: 7 }}>-</span>
                <span style={{ width: "17%", fontSize: 7, textAlign: "right" }}>₹{formatNumber(totalSGST)}</span>
                <span style={{ width: "17%", fontSize: 7, textAlign: "right" }}>₹{formatNumber(totalCGST)}</span>
                <span style={{ width: "15%", fontSize: 7, textAlign: "right" }}>₹{formatNumber(0)}</span>
                <span style={{ width: "19%", fontSize: 7, textAlign: "right" }}>₹{formatNumber(totalTaxAmount)}</span>
              </div>
            </div>

            {/* Summary */}
            <div style={{ fontSize: 9, marginTop: 5 }}>
              {safeInvoice.discountPercentage > 0 && (
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>Discount ({safeInvoice.discountPercentage}%)</span>
                  <span>-₹{formatNumber(safeInvoice.discountAmount)}</span>
                </div>
              )}
              
              {totalTaxAmount > 0 && (
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>Total Tax (CGST+SGST)</span>
                  <span>₹{formatNumber(totalTaxAmount)}</span>
                </div>
              )}
              
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontWeight: "bold",
                  marginTop: 5,
                  fontSize: 13,
                }}
              >
                <span>TOTAL</span>
                <span>₹{formatNumber(safeInvoice.total)}</span>
              </div>
            </div>

            <div style={{ borderTop: "1px dashed #000", margin: "5px 0" }} />

            {/* Footer */}
            <div style={{ textAlign: "center", fontSize: 9, marginTop: 5 }}>
              <div>This is a computer-generated invoice</div>
              
              {safeInvoice.discountPercentage > 0 && safeInvoice.discountAmount > 0 && (
                <div style={{ fontWeight: "bold", marginTop: 3, marginBottom: 3 }}>
                  You have saved ₹{formatNumber(safeInvoice.discountAmount)} by shopping here!
                </div>
              )}
              
              <div style={{ marginTop: 5 }}>
                <div style={{ fontWeight: "bold" }}>Thank You!</div>
                <div>Please visit us again</div>
              </div>
              
              <div style={{ marginTop: 3, fontSize: 8 }}>
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
          
          @media print {
            html, body {
              margin: 0;
              padding: 0;
              background: #fff;
              -webkit-print-color-adjust: exact;
              print-color-adjust: exact;
            }
            
            .invoice-wrapper {
              width: 80mm;
              margin: 0;
              padding: 0;
            }
            
            .invoice-content {
              padding: 0 3mm;
            }
          }
        `}</style>
      </>
    );
  }
);

PrintableInvoice.displayName = "PrintableInvoice";
export default PrintableInvoice;