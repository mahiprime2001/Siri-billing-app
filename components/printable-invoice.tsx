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

    const itemRows = safeInvoice.items.map((item) => {
      const quantity = Number(item.quantity || 0);
      const itemTotal = Number(item.total || 0);
      const taxPercent = Number(item.taxPercentage || 0);
      const totalTax = Math.round((itemTotal * taxPercent) / 100 * 100) / 100;
      const lineTotalAfterTax = Math.round((itemTotal + totalTax) * 100) / 100;
      const unitAmountAfterTax =
        quantity > 0 ? Math.round((lineTotalAfterTax / quantity) * 100) / 100 : 0;

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
      { hsnCode: string; gst: number; totalQuantity: number; taxableAmount: number; cgst: number; sgst: number; igst: number; totalTax: number; totalAfterTax: number }
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
            fontSize: 13,
            lineHeight: 1.6,
            fontWeight: 650,
            fontFamily: "Courier New, monospace",
            color: "#0b0b0b",
          }}
        >
          {/* Header */}
          <div style={{ textAlign: "center", marginBottom: 5 }}>
            <div style={{ fontWeight: "bold", fontSize: 18 }}>
              {safeInvoice.companyName}
            </div>
            <div style={{ fontSize: 12 }}>
              {safeInvoice.storeAddress || safeInvoice.companyAddress}
            </div>
            <div style={{ fontSize: 12 }}>Ph: {safeInvoice.storePhone || safeInvoice.companyPhone}</div>
            <div style={{ fontSize: 12 }}>Email: {safeInvoice.companyEmail}</div>
            {safeInvoice.gstin && (
              <div style={{ fontSize: 12 }}>GSTIN: {safeInvoice.gstin}</div>
            )}
          </div>

          <div style={{ borderTop: "1px dashed #000", margin: "5px 0" }} />

          {/* Invoice & Customer */}
          <div style={{ fontSize: 12, marginBottom: 7 }}>
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
            <div style={{ fontSize: 12, marginBottom: 7 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  borderBottom: "1px dashed #000",
                  paddingBottom: 2,
                  marginBottom: 3,
                  fontSize: 10,
                }}
              >
                <span style={{ width: "8%" }}>S.No</span>
                <span style={{ width: "36%" }}>Product</span>
                <span style={{ width: "28%", textAlign: "right" }}>Qty x Amt (After Tax)</span>
                <span style={{ width: "28%", textAlign: "right" }}>Total</span>
              </div>
              {itemRows.map((item, i) => (
                <div key={i} style={{ marginBottom: 3 }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      marginBottom: 1,
                      fontSize: 11,
                    }}
                  >
                    <span style={{ width: "8%" }}>{i + 1}</span>
                    <span style={{ width: "36%" }}>{item.name}</span>
                    <span style={{ width: "28%", textAlign: "right" }}>
                      {item.quantity} x ₹{formatNumber(item.unitAmountAfterTax)}
                    </span>
                    <span style={{ width: "28%", textAlign: "right" }}>
                      ₹{formatNumber(item.lineTotalAfterTax)}
                    </span>
                  </div>
                  {item.replacementTag && (
                    <div style={{ fontSize: 10, fontWeight: "bold", marginLeft: "8%" }}>{item.replacementTag}</div>
                  )}
                </div>
              ))}
              <div
                style={{
                  borderTop: "1px dashed #000",
                  marginTop: 3,
                  paddingTop: 3,
                  fontSize: 11,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>Total Quantity</span>
                  <span>{formatNumber(totalQuantity)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>Total (After Tax)</span>
                  <span>₹{formatNumber(totalAfterTaxRounded)}</span>
                </div>
              </div>
            </div>

            <div style={{ borderTop: "1px dashed #000", margin: "5px 0" }} />

            <div style={{ fontSize: 12, marginBottom: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontWeight: "bold" }}>
                <span>Total Amount Before Tax</span>
                <span>₹{formatNumber(totalBeforeTax)}</span>
              </div>
            </div>

            <div style={{ borderTop: "1px dashed #000", margin: "5px 0" }} />

            {/* Tax Classification - NO BORDERS, using spacing and dashed lines */}
            <div style={{ fontSize: 10, marginTop: 7, marginBottom: 7 }}>
              <div style={{ fontWeight: "bold", marginBottom: 3, fontSize: 11 }}>
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
                <span style={{ width: "17%", fontSize: 9 }}>HSN</span>
                <span style={{ width: "11%", fontSize: 9, textAlign: "right" }}>Qty</span>
                <span style={{ width: "18%", fontSize: 9, textAlign: "right" }}>Taxable</span>
                <span style={{ width: "14%", fontSize: 9, textAlign: "right" }}>CGST</span>
                <span style={{ width: "14%", fontSize: 9, textAlign: "right" }}>SGST</span>
                <span style={{ width: "10%", fontSize: 9, textAlign: "right" }}>IGST</span>
                <span style={{ width: "16%", fontSize: 9, textAlign: "right" }}>Total</span>
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
                  <span style={{ width: "17%", fontSize: 9 }}>
                    <div>{row.hsnCode}</div>
                    <div style={{ fontSize: 8 }}>GST {formatNumber(row.gst)}%</div>
                  </span>
                  <span style={{ width: "11%", fontSize: 9, textAlign: "right" }}>
                    {formatNumber(row.totalQuantity)}
                  </span>
                  <span style={{ width: "18%", fontSize: 9, textAlign: "right" }}>
                    ₹{formatNumber(row.taxableAmount)}
                  </span>
                  <span style={{ width: "14%", fontSize: 9, textAlign: "right" }}>
                    ₹{formatNumber(row.cgst)}
                  </span>
                  <span style={{ width: "14%", fontSize: 9, textAlign: "right" }}>
                    ₹{formatNumber(row.sgst)}
                  </span>
                  <span style={{ width: "10%", fontSize: 9, textAlign: "right" }}>
                    ₹{formatNumber(row.igst)}
                  </span>
                  <span style={{ width: "16%", fontSize: 9, textAlign: "right" }}>
                    ₹{formatNumber(row.totalAfterTax)}
                  </span>
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
                <span style={{ width: "17%", fontSize: 9 }}>Total</span>
                <span style={{ width: "11%", fontSize: 9, textAlign: "right" }}>{formatNumber(groupedTotalQty)}</span>
                <span style={{ width: "18%", fontSize: 9, textAlign: "right" }}>₹{formatNumber(groupedTaxableTotal)}</span>
                <span style={{ width: "14%", fontSize: 9, textAlign: "right" }}>₹{formatNumber(totalCGST)}</span>
                <span style={{ width: "14%", fontSize: 9, textAlign: "right" }}>₹{formatNumber(totalSGST)}</span>
                <span style={{ width: "10%", fontSize: 9, textAlign: "right" }}>₹{formatNumber(totalIGST)}</span>
                <span style={{ width: "16%", fontSize: 9, textAlign: "right" }}>₹{formatNumber(groupedTotalAfterTax)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 3, fontWeight: "bold" }}>
                <span>Total Tax Amount</span>
                <span>₹{formatNumber(totalTaxAmount)}</span>
              </div>
            </div>

            <div style={{ borderTop: "1px dashed #000", margin: "5px 0" }} />

            {/* Summary */}
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
                  fontWeight: "bold",
                  marginTop: 5,
                  fontSize: 17,
                }}
              >
                <span>Grand Total</span>
                <span>₹{formatNumber(safeInvoice.total)}</span>
              </div>
            </div>

            <div style={{ borderTop: "1px dashed #000", margin: "5px 0" }} />

            <div style={{ textAlign: "left", fontSize: 10, marginTop: 7, lineHeight: 1.5 }}>
              <div style={{ fontWeight: "bold", marginBottom: 2 }}>Terms and Conditions:</div>
              <div>* NO GURANTEE, NO RETURN</div>
              <div>* GOODS Once Sold Cannot be exchanged</div>
              <div>* Total amount Inclusive of GST</div>
              <div>For any queries, please contact our customer service team.</div>
              <div>
                Customer care number: {safeInvoice.companyPhone || "Store Number"} (please feel free to contact us using
                the same number in WhatsApp)
              </div>
              <div>Email.id: {safeInvoice.companyEmail || "-"}</div>
            </div>

            <div style={{ borderTop: "1px dashed #000", margin: "5px 0" }} />

            {/* Footer */}
            <div style={{ textAlign: "center", fontSize: 12, marginTop: 7 }}>
              {(invoice as any).isReplacementBill && (
                <div style={{ fontWeight: "bold", marginBottom: 4 }}>
                  THIS IS A BILL FOR REPLACEMENT
                </div>
              )}
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
