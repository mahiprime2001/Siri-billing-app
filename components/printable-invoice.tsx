"use client";

import React, { forwardRef } from "react";

interface PrintableInvoiceProps {
  invoice: Invoice;
  paperSize: string;
}

const PrintableInvoice = forwardRef<HTMLDivElement, PrintableInvoiceProps>(({ invoice }, ref) => {
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

  const itemRows = safeInvoice.items.map((item) => {
    const quantity = Number(item.quantity || 0);
    const itemTotal = Number(item.total || 0);
    const taxPercent = Number(item.taxPercentage || 0);
    const totalTax = Math.round((itemTotal * taxPercent) / 100 * 100) / 100;
    const lineTotalAfterTax = Math.round((itemTotal + totalTax) * 100) / 100;
    const unitAmountAfterTax = quantity > 0 ? Math.round((lineTotalAfterTax / quantity) * 100) / 100 : 0;

    return {
      ...item,
      quantity,
      taxPercent,
      totalTax,
      unitAmountAfterTax,
      lineTotalAfterTax,
    };
  });

  const totalQuantity = itemRows.reduce((sum, row) => sum + row.quantity, 0);
  const totalAfterTax = itemRows.reduce((sum, row) => sum + row.lineTotalAfterTax, 0);
  const totalAfterTaxRounded = Math.round(totalAfterTax * 100) / 100;
  const totalBeforeTax =
    Number(safeInvoice.subtotal || 0) > 0
      ? Number(safeInvoice.subtotal || 0)
      : Math.round(itemRows.reduce((sum, row) => sum + Number(row.total || 0), 0) * 100) / 100;

  const taxGroupMap = new Map<
    string,
    {
      hsnCode: string;
      gst: number;
      totalQuantity: number;
      taxableAmount: number;
      cgst: number;
      sgst: number;
      igst: number;
      totalTax: number;
      totalAfterTax: number;
    }
  >();

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
        hsnCode,
        gst,
        totalQuantity: row.quantity,
        taxableAmount,
        cgst,
        sgst,
        igst: 0,
        totalTax,
        totalAfterTax: totalAfterTaxByHsn,
      });
    }
  });

  const taxClassificationRows = Array.from(taxGroupMap.values()).map((row) => ({
    ...row,
    totalQuantity: Math.round(row.totalQuantity * 100) / 100,
    taxableAmount: Math.round(row.taxableAmount * 100) / 100,
    cgst: Math.round(row.cgst * 100) / 100,
    sgst: Math.round(row.sgst * 100) / 100,
    totalTax: Math.round(row.totalTax * 100) / 100,
    totalAfterTax: Math.round(row.totalAfterTax * 100) / 100,
  }));

  const groupedTotalQty = taxClassificationRows.reduce((sum, row) => sum + row.totalQuantity, 0);
  const groupedTaxableTotal = taxClassificationRows.reduce((sum, row) => sum + row.taxableAmount, 0);
  const totalCGST = taxClassificationRows.reduce((sum, row) => sum + row.cgst, 0);
  const totalSGST = taxClassificationRows.reduce((sum, row) => sum + row.sgst, 0);
  const totalIGST = taxClassificationRows.reduce((sum, row) => sum + row.igst, 0);
  const totalTaxAmount = taxClassificationRows.reduce((sum, row) => sum + row.totalTax, 0);
  const groupedTotalAfterTax = taxClassificationRows.reduce((sum, row) => sum + row.totalAfterTax, 0);

  const printedAt = safeInvoice.timestamp ? new Date(safeInvoice.timestamp) : new Date();

  const tableBaseStyle: React.CSSProperties = {
    width: "100%",
    borderCollapse: "collapse",
    tableLayout: "fixed",
  };

  const thBaseStyle: React.CSSProperties = {
    textAlign: "left",
    fontWeight: 700,
    color: "#000",
    padding: "2px 1px",
    borderBottom: "1px dashed #000",
    verticalAlign: "top",
  };

  const tdBaseStyle: React.CSSProperties = {
    padding: "2px 1px",
    verticalAlign: "top",
    color: "#000",
    fontWeight: 700,
  };

  return (
    <>
      <div
        className="invoice-wrapper"
        ref={ref}
        style={{
          width: "100%",
          maxWidth: "100%",
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
            padding: "0 2mm",
            boxSizing: "border-box",
            fontSize: 13,
            lineHeight: 1.5,
            fontWeight: 700,
            fontFamily: "Courier New, monospace",
            color: "#000",
          }}
        >
          <div style={{ textAlign: "center", marginBottom: 5 }}>
            <div style={{ fontWeight: 900, fontSize: 18 }}>{safeInvoice.companyName}</div>
            <div style={{ fontSize: 12 }}>{safeInvoice.storeAddress || safeInvoice.companyAddress}</div>
            <div style={{ fontSize: 12 }}>Ph: {safeInvoice.storePhone || safeInvoice.companyPhone}</div>
            <div style={{ fontSize: 12 }}>Email: {safeInvoice.companyEmail}</div>
            {safeInvoice.gstin && <div style={{ fontSize: 12 }}>GSTIN: {safeInvoice.gstin}</div>}
          </div>

          <div style={{ borderTop: "1px dashed #000", margin: "5px 0" }} />

          <div style={{ fontSize: 12, marginBottom: 7 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Invoice #{safeInvoice.id}</span>
              <span>Date: {printedAt.toLocaleDateString()}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Time: {printedAt.toLocaleTimeString()}</span>
              <span>Payment: {safeInvoice.paymentMethod}</span>
            </div>
            <div>Customer: {safeInvoice.customerName}</div>
            {safeInvoice.customerPhone && <div>Phone: {safeInvoice.customerPhone}</div>}
            <div>Billed by: {safeInvoice.billedBy || "N/A"}</div>
          </div>

          <div style={{ borderTop: "1px dashed #000", margin: "5px 0" }} />

          <div style={{ fontSize: 12, marginBottom: 7 }}>
            <table style={tableBaseStyle}>
              <colgroup>
                <col style={{ width: "10%" }} />
                <col style={{ width: "40%" }} />
                <col style={{ width: "25%" }} />
                <col style={{ width: "25%" }} />
              </colgroup>
              <thead>
                <tr>
                  <th style={{ ...thBaseStyle, fontSize: 10 }}>S.No</th>
                  <th style={{ ...thBaseStyle, fontSize: 10 }}>Product</th>
                  <th style={{ ...thBaseStyle, fontSize: 10, textAlign: "right" }}>Qty x Amt</th>
                  <th style={{ ...thBaseStyle, fontSize: 10, textAlign: "right" }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {itemRows.map((item, i) => (
                  <React.Fragment key={i}>
                    <tr>
                      <td style={{ ...tdBaseStyle, fontSize: 11 }}>{i + 1}</td>
                      <td style={{ ...tdBaseStyle, fontSize: 11, wordBreak: "break-word" }}>{item.name}</td>
                      <td style={{ ...tdBaseStyle, fontSize: 11, textAlign: "right" }}>
                        {item.quantity} x ₹{formatNumber(item.unitAmountAfterTax)}
                      </td>
                      <td style={{ ...tdBaseStyle, fontSize: 11, textAlign: "right" }}>
                        ₹{formatNumber(item.lineTotalAfterTax)}
                      </td>
                    </tr>
                    {item.replacementTag && (
                      <tr>
                        <td style={{ ...tdBaseStyle, fontSize: 10 }} />
                        <td colSpan={3} style={{ ...tdBaseStyle, fontSize: 10, fontWeight: 700 }}>
                          {item.replacementTag}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3} style={{ ...tdBaseStyle, borderTop: "1px dashed #000", paddingTop: 3 }}>
                    Total Quantity
                  </td>
                  <td style={{ ...tdBaseStyle, borderTop: "1px dashed #000", textAlign: "right", paddingTop: 3 }}>
                    {formatNumber(totalQuantity)}
                  </td>
                </tr>
                <tr>
                  <td colSpan={3} style={{ ...tdBaseStyle }}>Total (After Tax)</td>
                  <td style={{ ...tdBaseStyle, textAlign: "right" }}>₹{formatNumber(totalAfterTaxRounded)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div style={{ borderTop: "1px dashed #000", margin: "5px 0" }} />

          <div style={{ fontSize: 12, marginBottom: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 900 }}>
              <span>Total Amount Before Tax</span>
              <span>₹{formatNumber(totalBeforeTax)}</span>
            </div>
          </div>

          <div style={{ borderTop: "1px dashed #000", margin: "5px 0" }} />

          <div style={{ fontSize: 10, marginTop: 7, marginBottom: 7 }}>
            <div style={{ fontWeight: 900, marginBottom: 3, fontSize: 11 }}>Tax Classification</div>
            <table style={tableBaseStyle}>
              <colgroup>
                <col style={{ width: "18%" }} />
                <col style={{ width: "11%" }} />
                <col style={{ width: "18%" }} />
                <col style={{ width: "14%" }} />
                <col style={{ width: "14%" }} />
                <col style={{ width: "10%" }} />
                <col style={{ width: "15%" }} />
              </colgroup>
              <thead>
                <tr>
                  <th style={{ ...thBaseStyle, fontSize: 9 }}>HSN</th>
                  <th style={{ ...thBaseStyle, fontSize: 9, textAlign: "right" }}>Qty</th>
                  <th style={{ ...thBaseStyle, fontSize: 9, textAlign: "right" }}>Taxable</th>
                  <th style={{ ...thBaseStyle, fontSize: 9, textAlign: "right" }}>CGST</th>
                  <th style={{ ...thBaseStyle, fontSize: 9, textAlign: "right" }}>SGST</th>
                  <th style={{ ...thBaseStyle, fontSize: 9, textAlign: "right" }}>IGST</th>
                  <th style={{ ...thBaseStyle, fontSize: 9, textAlign: "right" }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {taxClassificationRows.map((row, index) => (
                  <tr key={index}>
                    <td style={{ ...tdBaseStyle, fontSize: 9 }}>
                      <div>{row.hsnCode}</div>
                      <div style={{ fontSize: 8 }}>GST {formatNumber(row.gst)}%</div>
                    </td>
                    <td style={{ ...tdBaseStyle, fontSize: 9, textAlign: "right" }}>{formatNumber(row.totalQuantity)}</td>
                    <td style={{ ...tdBaseStyle, fontSize: 9, textAlign: "right" }}>₹{formatNumber(row.taxableAmount)}</td>
                    <td style={{ ...tdBaseStyle, fontSize: 9, textAlign: "right" }}>₹{formatNumber(row.cgst)}</td>
                    <td style={{ ...tdBaseStyle, fontSize: 9, textAlign: "right" }}>₹{formatNumber(row.sgst)}</td>
                    <td style={{ ...tdBaseStyle, fontSize: 9, textAlign: "right" }}>₹{formatNumber(row.igst)}</td>
                    <td style={{ ...tdBaseStyle, fontSize: 9, textAlign: "right" }}>₹{formatNumber(row.totalAfterTax)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td style={{ ...tdBaseStyle, borderTop: "1px dashed #000", paddingTop: 3, fontWeight: 900 }}>Total</td>
                  <td style={{ ...tdBaseStyle, borderTop: "1px dashed #000", paddingTop: 3, textAlign: "right", fontWeight: 900 }}>
                    {formatNumber(groupedTotalQty)}
                  </td>
                  <td style={{ ...tdBaseStyle, borderTop: "1px dashed #000", paddingTop: 3, textAlign: "right", fontWeight: 900 }}>
                    ₹{formatNumber(groupedTaxableTotal)}
                  </td>
                  <td style={{ ...tdBaseStyle, borderTop: "1px dashed #000", paddingTop: 3, textAlign: "right", fontWeight: 900 }}>
                    ₹{formatNumber(totalCGST)}
                  </td>
                  <td style={{ ...tdBaseStyle, borderTop: "1px dashed #000", paddingTop: 3, textAlign: "right", fontWeight: 900 }}>
                    ₹{formatNumber(totalSGST)}
                  </td>
                  <td style={{ ...tdBaseStyle, borderTop: "1px dashed #000", paddingTop: 3, textAlign: "right", fontWeight: 900 }}>
                    ₹{formatNumber(totalIGST)}
                  </td>
                  <td style={{ ...tdBaseStyle, borderTop: "1px dashed #000", paddingTop: 3, textAlign: "right", fontWeight: 900 }}>
                    ₹{formatNumber(groupedTotalAfterTax)}
                  </td>
                </tr>
              </tfoot>
            </table>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 3, fontWeight: 900, fontSize: 10 }}>
              <span>Total Tax Amount</span>
              <span>₹{formatNumber(totalTaxAmount)}</span>
            </div>
          </div>

          <div style={{ borderTop: "1px dashed #000", margin: "5px 0" }} />

          <div style={{ fontSize: 12, marginTop: 7 }}>
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
                fontWeight: 900,
                marginTop: 5,
                fontSize: 17,
              }}
            >
              <span>Grand Total: </span>
              <span>₹{formatNumber(safeInvoice.total)}</span>
            </div>
          </div>

          <div style={{ borderTop: "1px dashed #000", margin: "5px 0" }} />

          <div style={{ textAlign: "left", fontSize: 10, marginTop: 7, lineHeight: 1.5 }}>
            <div style={{ fontWeight: 900, marginBottom: 2 }}>Terms and Conditions:</div>
            <div style={{ paddingLeft: 4 }}>* NO GURANTEE, NO RETURN</div>
            <div style={{ paddingLeft: 4 }}>* GOODS Once Sold Cannot be exchanged</div>
            <div style={{ paddingLeft: 4 }}>* Total amount Inclusive of GST</div>
          </div>

          <div style={{ borderTop: "1px dashed #000", margin: "5px 0" }} />

          <div style={{ textAlign: "center", fontSize: 12, marginTop: 7, paddingBottom: "5mm" }}>
            {(invoice as any).isReplacementBill && (
              <div style={{ fontWeight: 900, marginBottom: 4 }}>THIS IS A BILL FOR REPLACEMENT</div>
            )}
            <div>This is a computer-generated invoice</div>

            {safeInvoice.discountPercentage > 0 && safeInvoice.discountAmount > 0 && (
              <div style={{ fontWeight: 900, marginTop: 3, marginBottom: 3 }}>
                You have saved ₹{formatNumber(safeInvoice.discountAmount)} by shopping here!
              </div>
            )}

            <div style={{ marginTop: 5 }}>
              <div style={{ fontWeight: 900 }}>Thank You!</div>
              <div>Please visit us again</div>
            </div>

            <div style={{ marginTop: 3, fontSize: 8 }}>{new Date().toLocaleString()}</div>
          </div>
        </div>
      </div>

      <style jsx global>{`
        @page {
          size: 80mm auto;
          margin: 0;
        }

        @media print {
          html,
          body {
            margin: 0;
            padding: 0;
            background: #fff;
            color: #000 !important;
            font-weight: 700 !important;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }

          .invoice-wrapper {
            width: 100%;
            margin: 0;
            padding: 0;
          }

          .invoice-content {
            padding: 0 2mm;
            color: #000 !important;
            font-weight: 700 !important;
          }
        }
      `}</style>
    </>
  );
});

PrintableInvoice.displayName = "PrintableInvoice";
export default PrintableInvoice;
