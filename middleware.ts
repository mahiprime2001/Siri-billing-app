import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import jwt from 'jsonwebtoken';

const JWT_SECRET = "Siriart@2025";

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Define routes that do not require authentication
  const publicRoutes = ['/login', '/api/auth/login', '/api/auth/forgot-password-proxy'];

  // Check if the current route is a public route
  if (publicRoutes.includes(pathname) || pathname.startsWith('/_next') || pathname.startsWith('/static')) {
    return NextResponse.next();
  }

  // Get the token from the cookie
  const token = request.cookies.get('auth_token')?.value;

  if (!token) {
    // Redirect to login page if no token is found
    return NextResponse.redirect(new URL('/login', request.url));
  }

  try {
    // Verify the token
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string, email: string, role: string };

    // Attach user info to the request (if needed, though not directly supported in Next.js middleware for `request` object)
    // For API routes, you'd typically re-verify the token in the route handler or pass info via headers.
    // For now, we'll just check if the token is valid.

    // Define routes that require specific roles/permissions
    const sensitiveRoutes = [
      { path: '/api/users', roles: ['admin'] },
      { path: '/api/products/upload', roles: ['admin', 'manager'] },
      { path: '/api/billing/save', roles: ['admin', 'cashier'] },
      // Add other sensitive routes and their required roles
    ];

    const matchedSensitiveRoute = sensitiveRoutes.find(route => pathname.startsWith(route.path));

    if (matchedSensitiveRoute) {
      if (!matchedSensitiveRoute.roles.includes(decoded.role)) {
        // Redirect or return forbidden if user does not have the required role
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    return NextResponse.next();
  } catch (error: any) {
    console.error("Token verification failed:", error);
    // Specifically handle TokenExpiredError
    if (error.name === 'TokenExpiredError') {
      console.log("JWT token expired, redirecting to login.");
      return NextResponse.redirect(new URL('/login', request.url));
    }
    // For any other token verification failure, also redirect to login
    return NextResponse.redirect(new URL('/login', request.url));
  }
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
