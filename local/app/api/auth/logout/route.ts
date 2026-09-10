import { NextResponse } from "next/server";
import { clearSessionCookieOptions, SESSION_COOKIE } from "@local/lib/session";

export async function POST() {
  const response = NextResponse.json({ success: true });
  response.cookies.set(SESSION_COOKIE, "", await clearSessionCookieOptions());
  return response;
}
