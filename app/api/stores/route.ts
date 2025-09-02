import { NextResponse } from "next/server"
import fs from "fs/promises"
import path from "path"

export async function GET() {
  try {
const dataPath = path.join(process.cwd(), "data", "json", "stores.json")
    const jsonData = await fs.readFile(dataPath, "utf-8")
    const stores = JSON.parse(jsonData)
    return NextResponse.json({ stores })
  } catch (error) {
    console.error("Error reading stores data:", error)
    return NextResponse.json({ message: "Error reading data" }, { status: 500 })
  }
}
