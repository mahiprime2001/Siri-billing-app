"use client";
import React, { forwardRef } from "react";

interface PrintableInvoiceProps {
  invoice: Invoice;
  paperSize: string;
}

// ✅ Edge Headless uses Blink engine — same as Chrome/your app preview.
// ALL modern CSS works: flex, @page, font-weight, padding — everything.
// No IE workarounds needed. This component is written for Chrome/Edge.

const PrintableInvoice = forwardRef<HTMLDivElement, PrintableInvoiceProps>(
  ({ invoice, paperSize }, ref) => {
    const fmt = (value: number | undefined | null | string) => {
      if (value == null || isNaN(Number(value))) return "0";
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
      items: invoice.items?.map((item) => ({
        ...item,
        price: item.price || 0,
        total: item.total || 0,
        quantity: item.quantity || 0,
      })) || [],
    };

    const itemRows = safeInvoice.items.map((item) => {
      const quantity = Number(item.quantity || 0);
      const itemTotal = Number(item.total || 0);
      const taxPercent = Number(item.taxPercentage || 0);
      const totalTax = Math.round((itemTotal * taxPercent) / 100 * 100) / 100;
      const lineTotalAfterTax = Math.round((itemTotal + totalTax) * 100) / 100;
      const unitAmountAfterTax = quantity > 0
        ? Math.round((lineTotalAfterTax / quantity) * 100) / 100
        : 0;
      return { ...item, quantity, taxPercent, totalTax, unitAmountAfterTax, lineTotalAfterTax };
    });

    const totalQuantity = itemRows.reduce((sum, r) => sum + r.quantity, 0);
    const totalAfterTax = itemRows.reduce((sum, r) => sum + r.lineTotalAfterTax, 0);
    const totalAfterTaxRounded = Math.round(totalAfterTax * 100) / 100;
    const totalBeforeTax =
      Number(safeInvoice.subtotal || 0) > 0
        ? Number(safeInvoice.subtotal || 0)
        : Math.round(itemRows.reduce((sum, r) => sum + Number(r.total || 0), 0) * 100) / 100;

    const taxGroupMap = new Map<string, {
      hsnCode: string; gst: number; totalQuantity: number;
      taxableAmount: number; cgst: number; sgst: number;
      igst: number; totalTax: number; totalAfterTax: number;
    }>();

    itemRows.forEach((row: any) => {
      const hsnCode = row.hsnCode || row.hsn || row.hsn_code || "-";
      const gst = row.taxPercent;
      const key = `${hsnCode}|${gst}`;
      const taxableAmount = Number(row.total || 0);
      const totalTax = row.totalTax;
      const cgst = Math.round((totalTax / 2) * 100) / 100;
      const sgst = Math.round((totalTax / 2) * 100) / 100;
      const totalAfterTaxByHsn = Math.round((taxableAmount + totalTax) * 100) / 100;
      const existing = taxGroupMap.get(key);
      if (existing) {
        existing.totalQuantity += row.quantity;
        existing.taxableAmount += taxableAmount;
        existing.cgst += cgst;
        existing.sgst += sgst;
        existing.totalTax += totalTax;
        existing.totalAfterTax += totalAfterTaxByHsn;
      } else {
        taxGroupMap.set(key, {
          hsnCode, gst, totalQuantity: row.quantity,
          taxableAmount, cgst, sgst, igst: 0, totalTax,
          totalAfterTax: totalAfterTaxByHsn,
        });
      }
    });

    const taxRows = Array.from(taxGroupMap.values()).map((r) => ({
      ...r,
      totalQuantity: Math.round(r.totalQuantity * 100) / 100,
      taxableAmount: Math.round(r.taxableAmount * 100) / 100,
      cgst: Math.round(r.cgst * 100) / 100,
      sgst: Math.round(r.sgst * 100) / 100,
      totalTax: Math.round(r.totalTax * 100) / 100,
      totalAfterTax: Math.round(r.totalAfterTax * 100) / 100,
    }));

    const gTotalQty = taxRows.reduce((s, r) => s + r.totalQuantity, 0);
    const gTaxable  = taxRows.reduce((s, r) => s + r.taxableAmount, 0);
    const computedCGST = taxRows.reduce((s, r) => s + r.cgst, 0);
    const computedSGST = taxRows.reduce((s, r) => s + r.sgst, 0);
    const gIGST     = taxRows.reduce((s, r) => s + r.igst, 0);
    const computedTotalTax = taxRows.reduce((s, r) => s + r.totalTax, 0);
    const invoiceCGST = Number(safeInvoice.cgst || 0);
    const invoiceSGST = Number(safeInvoice.sgst || 0);
    const invoiceTaxAmount = Number(safeInvoice.taxAmount || 0);
    const gCGST = computedCGST > 0 ? computedCGST : invoiceCGST;
    const gSGST = computedSGST > 0 ? computedSGST : invoiceSGST;
    const gTotalTax = computedTotalTax > 0 ? computedTotalTax : (invoiceTaxAmount || (gCGST + gSGST));
    const gAfterTax = taxRows.reduce((s, r) => s + r.totalAfterTax, 0);

    const printedAt = safeInvoice.timestamp
      ? new Date(safeInvoice.timestamp)
      : new Date();

    const divider = (
      <div style={{ borderTop: "1px dashed #000", margin: "5px 0" }} />
    );

    const isThermalPaper = paperSize.includes("Thermal")
    const wrapperWidth = "100%"
    const wrapperMargin = "0 auto"
    const wrapperPadding = isThermalPaper ? "0" : "2mm"

    return (
      <>
        <div
          className="invoice-wrapper"
          ref={ref}
          style={{
            width: wrapperWidth,
            margin: wrapperMargin,
            padding: wrapperPadding,
            boxSizing: "border-box",
            background: "#fff",
            fontFamily: "'Courier New', Courier, monospace",
            fontSize: "12px",
            fontWeight: 500,
            color: "#000",
            lineHeight: "1.5",
          }}
        >

          {/* ── HEADER ── */}
          <div style={{ textAlign: "center", marginBottom: "6px" }}>
            <div style={{ fontWeight: 800, fontSize: "17px", letterSpacing: "0.5px" }}>
              {safeInvoice.companyName}
            </div>
            <div style={{ fontSize: "11px", marginTop: "2px" }}>
              {safeInvoice.storeAddress || safeInvoice.companyAddress}
            </div>
            <div style={{ fontSize: "11px" }}>Ph: {safeInvoice.storePhone || safeInvoice.companyPhone}</div>
            <div style={{ fontSize: "11px" }}>Email: {safeInvoice.companyEmail}</div>
            {safeInvoice.gstin && (
              <div style={{ fontSize: "11px" }}>GSTIN: {safeInvoice.gstin}</div>
            )}
          </div>

          {divider}

          {/* ── INVOICE META ── */}
          <div style={{ fontSize: "11px", marginBottom: "6px" }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Invoice #{safeInvoice.id}</span>
              <span>{printedAt.toLocaleDateString()}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Time: {printedAt.toLocaleTimeString()}</span>
              <span>Payment: {safeInvoice.paymentMethod}</span>
            </div>
            <div>Customer: {safeInvoice.customerName}</div>
            {safeInvoice.customerPhone && (
              <div>Phone: {safeInvoice.customerPhone}</div>
            )}
            <div>Billed by: {safeInvoice.billedBy || "N/A"}</div>
          </div>

          {divider}

          {/* ── ITEMS TABLE ── */}
          <div style={{ fontSize: "11px", marginBottom: "6px" }}>
            {/* Header row */}
            <div style={{
              display: "flex",
              borderBottom: "1px dashed #000",
              paddingBottom: "2px",
              marginBottom: "3px",
              fontSize: "10px",
              fontWeight: 700,
            }}>
              <span style={{ width: "8%",  flexShrink: 0 }}>#</span>
              <span style={{ flex: 1 }}>Product</span>
              <span style={{ width: "32%", flexShrink: 0, textAlign: "right" }}>Qty × Amt</span>
              <span style={{ width: "22%", flexShrink: 0, textAlign: "right" }}>Total</span>
            </div>
            {/* Item rows */}
            {itemRows.map((item, i) => (
              <div key={i} style={{ marginBottom: "2px" }}>
                <div style={{ display: "flex", fontSize: "11px" }}>
                  <span style={{ width: "8%", flexShrink: 0 }}>{i + 1}</span>
                  <span style={{ flex: 1, wordBreak: "break-word" }}>{item.name}</span>
                  <span style={{ width: "32%", flexShrink: 0, textAlign: "right" }}>
                    {item.quantity} × ₹{fmt(item.unitAmountAfterTax)}
                  </span>
                  <span style={{ width: "22%", flexShrink: 0, textAlign: "right" }}>
                    ₹{fmt(item.lineTotalAfterTax)}
                  </span>
                </div>
                <div style={{ fontSize: "9px", color: "#222", paddingLeft: "8%" }}>
                  Barcode: {String(
                    (item as any).barcode ||
                    (item as any).bar_code ||
                    (item as any).productBarcode ||
                    (item as any).barcodes ||
                    "",
                  )
                    .split(",")[0]
                    .trim() || "-"} | HSN: {(item as any).hsnCode || (item as any).hsn || (item as any).hsn_code || "-"}
                </div>
                {(item as any).replacementTag && (
                  <div style={{ fontSize: "10px", fontWeight: 700, paddingLeft: "8%" }}>
                    {(item as any).replacementTag}
                  </div>
                )}
              </div>
            ))}
            {/* Footer rows */}
            <div style={{ borderTop: "1px dashed #000", paddingTop: "3px", marginTop: "3px" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Total Quantity</span>
                <span>{fmt(totalQuantity)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Total (After Tax)</span>
                <span>₹{fmt(totalAfterTaxRounded)}</span>
              </div>
            </div>
          </div>

          {divider}

          {/* ── TOTAL BEFORE TAX ── */}
          <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700, fontSize: "12px", marginBottom: "4px" }}>
            <span>Total Amount Before Tax</span>
            <span>₹{fmt(totalBeforeTax)}</span>
          </div>

          {divider}

          {/* ── TAX CLASSIFICATION ── */}
          <div style={{ fontSize: "10px", marginBottom: "6px" }}>
            <div style={{ fontWeight: 800, fontSize: "12px", marginBottom: "3px" }}>
              Tax Classification
            </div>
            {/* Header */}
            <div style={{
              display: "flex",
              borderBottom: "1px dashed #000",
              paddingBottom: "2px",
              marginBottom: "2px",
              fontWeight: 700,
              fontSize: "9px",
            }}>
              <span style={{ width: "20%", flexShrink: 0 }}>HSN</span>
              <span style={{ width: "10%", flexShrink: 0, textAlign: "right" }}>Qty</span>
              <span style={{ width: "20%", flexShrink: 0, textAlign: "right" }}>Taxable</span>
              <span style={{ width: "14%", flexShrink: 0, textAlign: "right" }}>CGST</span>
              <span style={{ width: "14%", flexShrink: 0, textAlign: "right" }}>SGST</span>
              <span style={{ width: "10%", flexShrink: 0, textAlign: "right" }}>IGST</span>
              <span style={{ width: "12%", flexShrink: 0, textAlign: "right" }}>Total</span>
            </div>
            {/* Data rows */}
            {taxRows.map((row, i) => (
              <div key={i} style={{ display: "flex", marginBottom: "2px", fontSize: "9px" }}>
                <span style={{ width: "20%", flexShrink: 0 }}>
                  <div>{row.hsnCode}</div>
                  <div style={{ fontSize: "8px" }}>GST {fmt(row.gst)}%</div>
                </span>
                <span style={{ width: "10%", flexShrink: 0, textAlign: "right" }}>{fmt(row.totalQuantity)}</span>
                <span style={{ width: "20%", flexShrink: 0, textAlign: "right" }}>₹{fmt(row.taxableAmount)}</span>
                <span style={{ width: "14%", flexShrink: 0, textAlign: "right" }}>₹{fmt(row.cgst)}</span>
                <span style={{ width: "14%", flexShrink: 0, textAlign: "right" }}>₹{fmt(row.sgst)}</span>
                <span style={{ width: "10%", flexShrink: 0, textAlign: "right" }}>₹{fmt(row.igst)}</span>
                <span style={{ width: "12%", flexShrink: 0, textAlign: "right" }}>₹{fmt(row.totalAfterTax)}</span>
              </div>
            ))}
            {/* Total row */}
            <div style={{
              display: "flex",
              borderTop: "1px dashed #000",
              paddingTop: "2px",
              marginTop: "2px",
              fontWeight: 800,
              fontSize: "9px",
            }}>
              <span style={{ width: "20%", flexShrink: 0 }}>Total</span>
              <span style={{ width: "10%", flexShrink: 0, textAlign: "right" }}>{fmt(gTotalQty)}</span>
              <span style={{ width: "20%", flexShrink: 0, textAlign: "right" }}>₹{fmt(gTaxable)}</span>
              <span style={{ width: "14%", flexShrink: 0, textAlign: "right" }}>₹{fmt(gCGST)}</span>
              <span style={{ width: "14%", flexShrink: 0, textAlign: "right" }}>₹{fmt(gSGST)}</span>
              <span style={{ width: "10%", flexShrink: 0, textAlign: "right" }}>₹{fmt(gIGST)}</span>
              <span style={{ width: "12%", flexShrink: 0, textAlign: "right" }}>₹{fmt(gAfterTax)}</span>
            </div>
            {/* Tax amount summary */}
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: "3px", fontWeight: 700 }}>
              <span>Total Tax Amount</span>
              <span>₹{fmt(gTotalTax)}</span>
            </div>
          </div>

          {divider}

          {/* ── GRAND TOTAL ── */}
          <div style={{ marginTop: "4px", marginBottom: "4px" }}>
            {safeInvoice.discountPercentage > 0 && (
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px" }}>
                <span>Discount ({safeInvoice.discountPercentage}%)</span>
                <span>-₹{fmt(safeInvoice.discountAmount)}</span>
              </div>
            )}
            <div style={{
              display: "flex",
              justifyContent: "space-between",
              fontWeight: 800,
              fontSize: "17px",
              marginTop: "4px",
            }}>
              <span>Grand Total</span>
              <span>₹{fmt(safeInvoice.total)}</span>
            </div>
          </div>

          {divider}

          {/* ── TERMS ── */}
          <div style={{ fontSize: "10px", lineHeight: "1.5", marginBottom: "4px" }}>
            <div style={{ fontWeight: 800, marginBottom: "2px" }}>Terms and Conditions:</div>
            <div>* NO GURANTEE, NO RETURN</div>
            <div>* GOODS Once Sold Cannot be exchanged</div>
            <div>* Total amount Inclusive of GST</div>
        
          </div>

          {divider}

          {/* ── FOOTER ── */}
          <div style={{ textAlign: "center", fontSize: "11px", paddingBottom: "6mm" }}>
            {(invoice as any).isReplacementBill && (
              <div style={{ fontWeight: 800, marginBottom: "4px" }}>
                THIS IS A BILL FOR REPLACEMENT
              </div>
            )}
            <div>This is a computer-generated invoice</div>
            {safeInvoice.discountPercentage > 0 && safeInvoice.discountAmount > 0 && (
              <div style={{ fontWeight: 800, margin: "3px 0" }}>
                You saved ₹{fmt(safeInvoice.discountAmount)} today!
              </div>
            )}
            <div style={{ marginTop: "6px" }}>
              <div style={{ fontWeight: 800, fontSize: "14px" }}>Thank You!</div>
              <div>Please visit us again</div>
            </div>
            <div style={{ marginTop: "4px", fontSize: "9px" }}>
              {printedAt.toLocaleString()}
            </div>
          </div>

        </div>

      </>
    );
  }
);

PrintableInvoice.displayName = "PrintableInvoice";
export default PrintableInvoice;
