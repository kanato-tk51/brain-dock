import { getToken } from "next-auth/jwt";
import { NextResponse, type NextRequest } from "next/server";
import { authBypassed, getAllowedEmail } from "@/lib/auth-constants";

function resolveSecret(): string {
  return process.env.NEXTAUTH_SECRET ?? "local-bypass-secret";
}

export async function middleware(request: NextRequest) {
  if (authBypassed()) {
    return NextResponse.next();
  }

  const { pathname } = request.nextUrl;
  if (pathname === "/login") {
    return NextResponse.next();
  }

  const token = await getToken({
    req: request,
    secret: resolveSecret(),
  });
  const nowSec = Math.floor(Date.now() / 1000);
  const exp = typeof token?.exp === "number" ? token.exp : 0;
  const email = typeof token?.email === "string" ? token.email.toLowerCase() : "";
  if (email === getAllowedEmail() && exp > nowSec) {
    return NextResponse.next();
  }

  const loginUrl = new URL("/login", request.url);
  const callbackUrl = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  loginUrl.searchParams.set("callbackUrl", callbackUrl);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!api/auth|_next/static|_next/image|favicon.ico|icon.png).*)"],
};
