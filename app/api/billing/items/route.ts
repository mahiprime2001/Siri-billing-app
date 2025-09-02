import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

export async function GET() {
  try {
    const itemsPath = path.join(process.cwd(), "data", "json", "billitems.json");
    const itemsData = await fs.readFile(itemsPath, "utf8");
    return NextResponse.json(JSON.parse(itemsData));
  } catch (error) {
    console.error("Failed to fetch bill items:", error);
    return NextResponse.json(
      { error: "Failed to fetch bill items" },
      { status: 500 }
    );
  }
}
