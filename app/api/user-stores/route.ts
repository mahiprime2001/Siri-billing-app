import { NextResponse } from "next/server";
import userStores from "@/data/json/userStores.json";

export async function GET() {
  return NextResponse.json(userStores);
}
