import { type NextRequest, NextResponse } from "next/server";
import { serialize } from "cookie";
import { logEvent, LogEventType } from "@/lib/log";
import { logSyncEvent, ChangeType } from "@/lib/sync";
import pool from "@/lib/db"; // Assuming lib/db.ts exports the mysql2 pool

export async function POST(request: NextRequest) {
  try {
    const cookieHeader = request.headers.get("cookie");
    const cookies = cookieHeader ? cookieHeader.split(';').map(c => c.trim()) : [];
    const authTokenCookie = cookies.find(cookie => cookie.startsWith('auth_token='));

    let userId: string | null = null; // Explicitly type userId
    if (authTokenCookie) {
      // In a real application, you would decode the JWT to get the userId
      // For this example, we'll just assume we can extract it or it's passed in the body
      // For now, let's assume the user ID is passed in the request body for simplicity
      const { userId: requestUserId } = await request.json();
      userId = requestUserId;
    }

    // Clear the authentication cookie
    const cookie = serialize("auth_token", "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 0, // Expire the cookie immediately
      path: "/",
    });

    if (userId) {
      await logEvent("USER_LOGOUT", userId);
      await logSyncEvent("USER_LOGOUT", { userId: userId });

      let connection;
      try {
        connection = await pool.getConnection();
        const logoutTime = new Date();

        // Fetch last login time
        const [rows]: any = await connection.query(
          "SELECT lastLogin, totalSessionDuration FROM Users WHERE id = ?",
          [userId]
        );

        if (rows.length > 0) {
          const user = rows[0];
          const lastLogin = user.lastLogin;
          let totalSessionDuration = user.totalSessionDuration || 0;

          if (lastLogin) {
            const loginTime = new Date(lastLogin);
            const sessionDuration = Math.floor((logoutTime.getTime() - loginTime.getTime()) / 1000); // duration in seconds
            totalSessionDuration += sessionDuration;
          }

          await connection.query(
            "UPDATE Users SET lastLogout = ?, totalSessionDuration = ? WHERE id = ?",
            [logoutTime, totalSessionDuration, userId]
          );
        }
      } catch (dbError: any) {
        // userId is guaranteed to be a string here because of the outer 'if (userId)' block
        await logEvent("OTHER_EVENT", userId, {
          message: "Failed to update user logout time and session duration",
          error: dbError.message,
          userId: userId,
        });
      } finally {
        if (connection) connection.release();
      }
    }

    return new NextResponse(JSON.stringify({ message: "Logged out successfully" }), {
      status: 200,
      headers: { "Set-Cookie": cookie, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    // Ensure userId is a string for logEvent
    const logUserId = userId || "unknown";
    await logEvent("OTHER_EVENT", logUserId, {
      message: "Logout error",
      error: error.message,
      // Do not include userId in details here, as logUserId already serves this purpose
      // and avoids potential nullability issues with the linter.
    });
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
