// app/api/auth/forgot-password-proxy/route.ts
// For App Router (app directory)

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

// Define schema for forgot password request body
const forgotPasswordSchema = z.object({
  email: z.string().email("Invalid email address"),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()

    // Validate the request body
    const validationResult = forgotPasswordSchema.safeParse(body);

    if (!validationResult.success) {
      return NextResponse.json(
        { success: false, message: 'Invalid request body', details: validationResult.error.errors },
        { status: 400 }
      );
    }

    const { email } = validationResult.data;

    // Forward request to PHP endpoint
    const phpEndpoint = process.env.PHP_FORGOT_PASSWORD_ENDPOINT || 'https://siri.ifleon.com/forgot-password.php'
    
    console.log('Forwarding request to PHP endpoint:', phpEndpoint)
    
    const response = await fetch(phpEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': process.env.PHP_API_KEY || '',
        'User-Agent': 'NextJS-App/1.0',
      },
      body: JSON.stringify({ email }),
    })

    console.log('PHP response status:', response.status)

    if (!response.ok) {
      console.error('PHP endpoint error:', response.status, response.statusText)
      throw new Error(`PHP endpoint returned status: ${response.status}`)
    }

    const data = await response.json()
    console.log('PHP response data:', data)
    
    return NextResponse.json({
      success: data.success || true,
      message: data.message || 'If an account with that email exists, we have sent a password reset link.'
    })

  } catch (error) {
    console.error('Error calling PHP forgot password endpoint:', error)
    
    return NextResponse.json(
      { success: false, message: 'Unable to process your request at this time. Please try again later.' },
      { status: 500 }
    )
  }
}

// Handle OPTIONS for CORS preflight if needed
export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  })
}
