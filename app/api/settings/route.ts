import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

export async function GET() {
  try {
    const settingsPath = path.join(
      process.cwd(),
"data",
"json",
"systemSettings.json"
    );
    const settingsData = await fs.readFile(settingsPath, "utf8");
    return NextResponse.json(JSON.parse(settingsData));
  } catch (error) {
    console.error("Failed to fetch settings:", error);
    return NextResponse.json(
      { error: "Failed to fetch settings" },
      { status: 500 }
    );
  }
}
