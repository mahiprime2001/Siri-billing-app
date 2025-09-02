import { type NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { logEvent, LogEventType } from "@/lib/log"; // Import LogEventType
import { logSyncEvent } from "@/lib/sync";
import jwt from "jsonwebtoken";
import { serialize } from "cookie";
import pool from "@/lib/db"; // Assuming lib/db.ts exports the mysql2 pool
import { z } from "zod"; // Import zod
import { checkRateLimit, recordAttempt } from "@/lib/rate-limit"; // Import rate limiter

const JWT_SECRET = process.env.JWT_SECRET || "your_jwt_secret"; // Use environment variable for secret

// Define schema for login request body
const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

export async function POST(request: NextRequest) {
  // Get IP address from request headers, considering proxies
  const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';

  // Check rate limit
  const { allowed, remaining, reset } = checkRateLimit(ip);

  if (!allowed) {
    return new NextResponse(
      JSON.stringify({ error: `Too many login attempts. Please try again after ${Math.ceil((reset - Date.now()) / 1000 / 60)} minutes.` }),
      {
        status: 429,
        headers: {
          'X-RateLimit-Limit': '10',
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': (reset / 1000).toString(),
          'Content-Type': 'application/json',
        },
      }
    );
  }

  try {
    const body = await request.json();

    // Validate the request body
    const validationResult = loginSchema.safeParse(body);

    if (!validationResult.success) {
      recordAttempt(ip, false); // Record failed attempt due to invalid body
      return NextResponse.json(
        { error: "Invalid request body", details: validationResult.error.errors },
        { status: 400 }
      );
    }

    const { email, password } = validationResult.data;

    const usersPath = path.join(process.cwd(), "data", "json", "users.json");
    const usersData = await fs.readFile(usersPath, "utf8");
    const users = JSON.parse(usersData);

    const user = users.find(
      (u: any) => u.email === email && u.password === password
    );

    if (user) {
      recordAttempt(ip, true); // Record successful attempt
      const { password: _, ...userWithoutPassword } = user;
      await logEvent("USER_LOGIN", user.id);
      await logSyncEvent("USER_LOGIN", { userId: user.id });

      let connection;
      try {
        connection = await pool.getConnection();
        const loginTime = new Date();

        // Fetch current user data to check for ungraceful logout
        const [rows]: any = await connection.query(
          "SELECT lastLogin, lastLogout, totalSessionDuration FROM Users WHERE id = ?",
          [user.id]
        );

        if (rows.length > 0) {
          const currentUserData = rows[0];
          const lastLoginTime = currentUserData.lastLogin ? new Date(currentUserData.lastLogin) : null;
          const lastLogoutTime = currentUserData.lastLogout ? new Date(currentUserData.lastLogout) : null;
          let totalSessionDuration = currentUserData.totalSessionDuration || 0;

          // Check for ungraceful logout (lastLogin exists and lastLogout is null or older than lastLogin)
          if (lastLoginTime && (!lastLogoutTime || lastLoginTime > lastLogoutTime)) {
            const ungracefulLogoutTime = loginTime; // Assume logout happened just before current login
            const missedSessionDuration = Math.floor((ungracefulLogoutTime.getTime() - lastLoginTime.getTime()) / 1000); // duration in seconds
            totalSessionDuration += missedSessionDuration;

            // Log this ungraceful logout event
            await logEvent("USER_UNGRACEFUL_LOGOUT", user.id);
            await logSyncEvent("USER_UNGRACEFUL_LOGOUT", { userId: user.id, duration: missedSessionDuration });

            // Update lastLogout and totalSessionDuration for the ungraceful session
            await connection.query(
              "UPDATE Users SET lastLogout = ?, totalSessionDuration = ? WHERE id = ?",
              [ungracefulLogoutTime, totalSessionDuration, user.id]
            );
          }

          // Update lastLogin for the current session
          await connection.query(
            "UPDATE Users SET lastLogin = ? WHERE id = ?",
            [loginTime, user.id]
          );
        }
      } catch (dbError: any) {
        await logEvent("OTHER_EVENT", user.id, {
          message: "Failed to update user login/logout times and session duration",
          error: dbError.message,
          userId: user.id,
        });
      } finally {
        if (connection) connection.release();
      }

      // Generate JWT token
      const token = jwt.sign({ userId: user.id, email: user.email, role: user.role }, JWT_SECRET, {
        expiresIn: "1h", // Token expires in 1 hour
      });

      // Set the token in an HTTP-only cookie
      const cookie = serialize("auth_token", token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production", // Use secure cookies in production
        sameSite: "strict",
        maxAge: 60 * 60, // 1 hour
        path: "/",
      });

      return new NextResponse(JSON.stringify({ user: userWithoutPassword }), {
        status: 200,
        headers: { "Set-Cookie": cookie, "Content-Type": "application/json" },
      });
    } else {
      recordAttempt(ip, false); // Record failed attempt due to invalid credentials
      return NextResponse.json(
        { error: "Invalid credentials" },
        { status: 401, headers: {
          'X-RateLimit-Limit': '10',
          'X-RateLimit-Remaining': remaining.toString(),
          'X-RateLimit-Reset': (reset / 1000).toString(),
        }}
      );
    }
  } catch (error) {
    recordAttempt(ip, false); // Record failed attempt due to internal error
    await logEvent("OTHER_EVENT", "unknown", {
      message: "Login error",
      error: (error as Error).message, // Cast to Error to access message property
      ip: ip,
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: {
        'X-RateLimit-Limit': '10',
        'X-RateLimit-Remaining': remaining.toString(),
        'X-RateLimit-Reset': (reset / 1000).toString(),
      }}
    );
  }
}
