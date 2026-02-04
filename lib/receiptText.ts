interface ReceiptCopy {
  label: string;
}

const getLineWidth = (paperSize: string): number => {
  if (paperSize === "Thermal 58mm") return 32;
  return 42;
};

const centerText = (text: string, width: number): string => {
  if (text.length >= width) return text.slice(0, width);
  const pad = Math.floor((width - text.length) / 2);
  return `${" ".repeat(pad)}${text}`;
};

const rightText = (text: string, width: number): string => {
  if (text.length >= width) return text.slice(0, width);
  return `${" ".repeat(width - text.length)}${text}`;
};

const twoColumn = (left: string, right: string, width: number): string => {
  const space = Math.max(1, width - left.length - right.length);
  return `${left}${" ".repeat(space)}${right}`;
};

const money = (value?: number | null): string => {
  const number = typeof value === "number" ? value : Number(value || 0);
  return `₹${number.toFixed(2)}`;
};

export function generateReceiptText(
  invoice: Invoice,
  paperSize: string,
  copies: ReceiptCopy[]
): string {
  const width = getLineWidth(paperSize);
  const line = "-".repeat(width);

  const buildReceipt = (label: string): string[] => {
    const lines: string[] = [];
    lines.push(centerText(label, width));
    lines.push(centerText((invoice.companyName || "").toUpperCase(), width));

    if (invoice.storeAddress || invoice.companyAddress) {
      lines.push(centerText(invoice.storeAddress || invoice.companyAddress || "", width));
    }
    if (invoice.companyPhone) {
      lines.push(centerText(`Ph: ${invoice.companyPhone}`, width));
    }
    if (invoice.companyEmail) {
      lines.push(centerText(invoice.companyEmail, width));
    }
    if (invoice.gstin) {
      lines.push(centerText(`GSTIN: ${invoice.gstin}`, width));
    }

    lines.push(line);
    lines.push(twoColumn(`Invoice: ${invoice.id}`, new Date(invoice.timestamp).toLocaleDateString(), width));
    lines.push(twoColumn(`Payment: ${invoice.paymentMethod || "Cash"}`, "", width));

    if (invoice.customerName && invoice.customerName !== "Walk-in Customer") {
      lines.push(line);
      lines.push(`Customer: ${invoice.customerName}`);
      if (invoice.customerPhone) {
        lines.push(`Phone: ${invoice.customerPhone}`);
      }
    }

    lines.push(line);
    (invoice.items || []).forEach((item) => {
      const name = (item.name || "Item").toString();
      lines.push(name.length > width ? name.slice(0, width) : name);
      const qtyLine = `${item.quantity || 0} x ${money(item.price || 0)}`;
      const totalLine = money(item.total || 0);
      lines.push(twoColumn(qtyLine, totalLine, width));
    });

    lines.push(line);
    lines.push(twoColumn("Subtotal", money(invoice.subtotal || 0), width));

    if ((invoice.discountPercentage || 0) > 0) {
      lines.push(
        twoColumn(
          `Discount (${invoice.discountPercentage || 0}%)`,
          `-${money(invoice.discountAmount || 0)}`,
          width
        )
      );
    }

    lines.push(twoColumn("Tax", money(invoice.taxAmount || 0), width));
    lines.push(line);
    lines.push(
      twoColumn(
        "TOTAL",
        money(invoice.total || 0),
        width
      )
    );
    lines.push(line);
    lines.push(centerText("Thank you for your business!", width));
    lines.push(centerText("This is a computer generated invoice", width));

    return lines;
  };

  const receiptBlocks = copies.map((copy) => buildReceipt(copy.label).join("\n"));
  return receiptBlocks.join(`\n${line}\n\n`);
}
