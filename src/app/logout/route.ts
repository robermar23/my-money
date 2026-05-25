import { sessionOptions } from "@/lib/auth/session.ts";
import { type NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 303 See Other: forces the browser to follow with a GET (default 307 would POST /login).
  const response = NextResponse.redirect(new URL("/login", request.url), { status: 303 });
  // Clear the iron-session cookie by overwriting it with an empty value + maxAge 0.
  // Avoids re-entering iron-session's cookie API in a route handler context where
  // dev-mode async-cookies tracking can mis-fire.
  response.cookies.set({
    name: sessionOptions.cookieName,
    value: "",
    maxAge: 0,
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  return response;
}
