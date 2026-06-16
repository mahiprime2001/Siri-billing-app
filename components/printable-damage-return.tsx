"use client";
import React, { forwardRef } from "react";

export interface DamageReturnPrintItem {
  name: string;
  barcode?: string;
  quantity: number;
}

export interface DamageReturnPrintData {
  id?: string;
  companyName?: string;
  storeName?: string;
  storeAddress?: string;
  storePhone?: string;
  createdAt?: string;
  reason?: string;
  reasonType?: string;
  damageOrigin?: string;
  status?: string;
  resolutionStatus?: string;
  createdBy?: string;
  items: DamageReturnPrintItem[];
}

interface PrintableDamageReturnProps {
  data: DamageReturnPrintData;
  paperSize: string;
}

const IST_TIMEZONE = "Asia/Kolkata";

const parseServerDate = (value: string | Date | undefined | null): Date | null => {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  const hasExplicitTimezone = /([zZ]|[+-]\d{2}:\d{2})$/.test(raw);
  // Backend stores bare timestamps as IST wall-clock (no tz suffix). Append +05:30
  // so the browser treats them as IST rather than UTC.
  const normalized = !hasExplicitTimezone && raw.includes("T") ? `${raw}+05:30` : raw;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const formatIstDate = (value: string | Date | undefined | null): string => {
  const parsed = parseServerDate(value);
  if (!parsed) return "-";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: IST_TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(parsed);
};

const formatIstTime = (value: string | Date | undefined | null): string => {
  const parsed = parseServerDate(value);
  if (!parsed) return "-";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: IST_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(parsed);
};

const titleCase = (value: string | undefined | null): string => {
  if (!value) return "-";
  return String(value)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
};

const PrintableDamageReturn = forwardRef<HTMLDivElement, PrintableDamageReturnProps>(
  ({ data, paperSize }, ref) => {
    const items = data.items || [];
    const totalQty = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    const printedAtRaw = data.createdAt || new Date().toISOString();

    const divider = <div style={{ borderTop: "1px dashed #000", margin: "5px 0" }} />;

    const isThermalPaper = paperSize.includes("Thermal");
    const wrapperPadding = isThermalPaper ? "0" : "2mm";

    return (
      <div
        className="invoice-wrapper"
        ref={ref}
        style={{
          width: "100%",
          margin: "0 auto",
          padding: wrapperPadding,
          boxSizing: "border-box",
          background: "#fff",
          fontFamily: "'Courier New', Courier, monospace",
          fontSize: "12px",
          fontWeight: 600,
          color: "#000",
          lineHeight: "1.5",
        }}
      >
        {/* ── HEADER ── */}
        <div style={{ textAlign: "center", marginBottom: "6px" }}>
          <div style={{ fontWeight: 800, fontSize: "17px", letterSpacing: "0.5px" }}>
            {data.companyName || data.storeName || "Store"}
          </div>
          {data.storeName && data.companyName && (
            <div style={{ fontSize: "11px", marginTop: "2px" }}>{data.storeName}</div>
          )}
          {data.storeAddress && <div style={{ fontSize: "11px" }}>{data.storeAddress}</div>}
          {data.storePhone && <div style={{ fontSize: "11px" }}>Ph: {data.storePhone}</div>}
          <div style={{ fontWeight: 800, fontSize: "13px", marginTop: "4px" }}>
            RETURN TO ADMIN
          </div>
        </div>

        {divider}

        {/* ── META ── */}
        <div style={{ fontSize: "11px", marginBottom: "6px" }}>
          {data.id && (
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Ref #{data.id}</span>
              <span>{formatIstDate(printedAtRaw)}</span>
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>Time: {formatIstTime(printedAtRaw)}</span>
            <span>Origin: {titleCase(data.damageOrigin)}</span>
          </div>
          <div>Reason: {data.reason || titleCase(data.reasonType)}</div>
          {data.status && <div>Status: {titleCase(data.status)}</div>}
          {data.resolutionStatus && <div>Resolution: {titleCase(data.resolutionStatus)}</div>}
          {data.createdBy && <div>By: {data.createdBy}</div>}
        </div>

        {divider}

        {/* ── ITEMS TABLE ── */}
        <div style={{ fontSize: "11px", marginBottom: "6px" }}>
          <div
            style={{
              display: "flex",
              borderBottom: "1px dashed #000",
              paddingBottom: "2px",
              marginBottom: "3px",
              fontSize: "10px",
              fontWeight: 700,
            }}
          >
            <span style={{ width: "8%", flexShrink: 0 }}>#</span>
            <span style={{ flex: 1 }}>Product</span>
            <span style={{ width: "18%", flexShrink: 0, textAlign: "right" }}>Qty</span>
          </div>
          {items.map((item, i) => (
            <div key={i} style={{ marginBottom: "2px" }}>
              <div style={{ display: "flex", fontSize: "11px" }}>
                <span style={{ width: "8%", flexShrink: 0 }}>{i + 1}</span>
                <span style={{ flex: 1, wordBreak: "break-word" }}>{item.name}</span>
                <span style={{ width: "18%", flexShrink: 0, textAlign: "right" }}>
                  {item.quantity}
                </span>
              </div>
              {item.barcode && (
                <div style={{ fontSize: "9px", color: "#222", paddingLeft: "8%" }}>
                  Barcode: {item.barcode}
                </div>
              )}
            </div>
          ))}
        </div>

        {divider}

        {/* ── TOTALS ── */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontSize: "12px",
            fontWeight: 800,
          }}
        >
          <span>Total Items: {items.length}</span>
          <span>Total Qty: {totalQty}</span>
        </div>

        {divider}

        <div style={{ textAlign: "center", fontSize: "10px", marginTop: "4px" }}>
          *** Products returned to admin ***
        </div>
      </div>
    );
  },
);

PrintableDamageReturn.displayName = "PrintableDamageReturn";

export default PrintableDamageReturn;
