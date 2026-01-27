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

    const pageWidth = "80mm"; // full roll width

    const safeInvoice = {
      ...invoice,
      subtotal: invoice.subtotal || 0,
      total: invoice.total || 0,
      discountPercentage: invoice.discountPercentage || 0,
      discountAmount: invoice.discountAmount || 0,
      taxAmount: invoice.taxAmount || 0,
      items:
        invoice.items?.map((item) => ({
          ...item,
          price: item.price || 0,
          total: item.total || 0,
          quantity: item.quantity || 0,
        })) || [],
    };

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
            {/* Logo */}

            {/* Header */}
            <div style={{ textAlign: "center", marginBottom: 6 }}>
              <div style={{ fontWeight: "bold", fontSize: 14 }}>
                {safeInvoice.companyName}
              </div>
              <div style={{ fontSize: 10 }}>{safeInvoice.companyAddress}</div>
              <div style={{ fontSize: 10 }}>Ph: {safeInvoice.companyPhone}</div>
              <div style={{ fontSize: 10 }}>Email: {safeInvoice.companyEmail}</div>
              <div style={{ fontSize: 10 }}>GSTIN: {safeInvoice.gstin}</div>
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
              {safeInvoice.discountPercentage > 0 && (
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>Discount ({safeInvoice.discountPercentage}%)</span>
                  <span>-₹{formatNumber(safeInvoice.discountAmount)}</span>
                </div>
              )}
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Tax</span>
                <span>₹{formatNumber(safeInvoice.taxAmount)}</span>
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontWeight: "bold",
                  marginTop: 6,
                  fontSize: 12,
                }}
              >
                <span>TOTAL</span>
                <span>₹{formatNumber(safeInvoice.total)}</span>
              </div>
            </div>

            {/* Footer */}
            <div style={{ textAlign: "center", fontSize: 10, marginTop: 6 }}>
              <div>Thank you for your business!</div>
              <div>This is a computer-generated invoice</div>
              <div>{new Date().toLocaleString()}</div>
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
