import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

export async function GET() {
  try {
    const barcodesPath = path.join(process.cwd(), "data", "json", "productbarcodes.json");
    const barcodesData = await fs.readFile(barcodesPath, "utf8");
    return NextResponse.json(JSON.parse(barcodesData));
  } catch (error) {
    console.error("Failed to fetch product barcodes:", error);
    return NextResponse.json(
      { error: "Failed to fetch product barcodes" },
      { status: 500 }
    );
  }
}
