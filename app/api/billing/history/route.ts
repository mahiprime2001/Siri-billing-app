import { type NextRequest, NextResponse } from "next/server";
import pool from "../../../../lib/db";
import { promises as fs } from "fs";
import path from "path";
import jwt from "jsonwebtoken";
import { parse } from "cookie";

const JWT_SECRET = process.env.JWT_SECRET || "your_jwt_secret";

export async function GET(request: NextRequest) {
  const cookies = parse(request.headers.get("cookie") || "");
  const token = cookies.auth_token;

  if (!token) {
    return NextResponse.json({ error: "Unauthorized: No token provided" }, { status: 401 });
  }

  let userId: string;
  try {
    const decodedToken = jwt.verify(token, JWT_SECRET) as { userId: string };
    userId = decodedToken.userId;
  } catch (error) {
    console.error("JWT verification failed:", error);
    return NextResponse.json({ error: "Unauthorized: Invalid token" }, { status: 401 });
  }

  try {
    const [userStores] = await pool.query(
      "SELECT storeId FROM UserStores WHERE userId = ?",
      [userId]
    );

    if (!Array.isArray(userStores) || userStores.length === 0) {
      return NextResponse.json([]);
    }

    const storeIds = userStores.map((row: any) => row.storeId);

    const [bills] = await pool.query(
      "SELECT * FROM Bills WHERE storeId IN (?)",
      [storeIds]
    );

    const filePath = path.join(process.cwd(), "data", "json", "bill.json");
    await fs.writeFile(filePath, JSON.stringify(bills, null, 2));

    return NextResponse.json(bills);
  } catch (error) {
    console.error("Failed to fetch billing history:", error);
    return NextResponse.json(
      { error: "Failed to fetch billing history" },
      { status: 500 }
    );
  }
}
