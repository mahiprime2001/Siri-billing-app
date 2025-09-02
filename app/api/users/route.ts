import { NextResponse } from "next/server"
import fs from "fs/promises"
import path from "path"

export async function GET() {
  try {
const dataPath = path.join(process.cwd(), "data", "json", "users.json")
    const jsonData = await fs.readFile(dataPath, "utf-8")
    const users = JSON.parse(jsonData)
    const filteredUsers = users.filter((user: any) => user.role === "billing_user" || user.role === "temporary_user")
    return NextResponse.json({ users: filteredUsers })
  } catch (error) {
    console.error("Error reading users data:", error)
    return NextResponse.json({ message: "Error reading data" }, { status: 500 })
  }
}
