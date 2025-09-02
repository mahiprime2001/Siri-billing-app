import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

export async function GET() {
  try {
    const customersPath = path.join(process.cwd(), "data", "json", "customers.json");
    const customersData = await fs.readFile(customersPath, "utf8");
    return NextResponse.json(JSON.parse(customersData));
  } catch (error) {
    console.error("Failed to fetch customers:", error);
    return NextResponse.json(
      { error: "Failed to fetch customers" },
      { status: 500 }
    );
  }
}
