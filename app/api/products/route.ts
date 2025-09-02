import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

export async function GET() {
  try {
    const productsPath = path.join(process.cwd(), "data", "json", "products.json");
    const barcodesPath = path.join(process.cwd(), "data", "json", "productbarcodes.json");

    const productsData = await fs.readFile(productsPath, "utf8");
    const barcodesData = await fs.readFile(barcodesPath, "utf8");

    const products = JSON.parse(productsData);
    const barcodes = JSON.parse(barcodesData);

    const productsWithBarcodes = products.map((product: any) => {
      const productBarcodes = barcodes.filter(
        (barcode: any) => barcode.productId === product.id
      );
      return {
        ...product,
        barcodes: productBarcodes.map((b: any) => b.barcode).join(','),
      };
    });

    return NextResponse.json(productsWithBarcodes);
  } catch (error) {
    console.error("Failed to fetch products:", error);
    return NextResponse.json(
      { error: "Failed to fetch products" },
      { status: 500 }
    );
  }
}
