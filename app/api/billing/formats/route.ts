import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

export async function GET() {
  try {
    const formatsPath = path.join(process.cwd(), "data", "json", "billformats.json");
    const formatsData = await fs.readFile(formatsPath, "utf8");
    return NextResponse.json(JSON.parse(formatsData));
  } catch (error) {
    console.error("Failed to fetch bill formats:", error);
    return NextResponse.json(
      { error: "Failed to fetch bill formats" },
      { status: 500 }
    );
  }
}
