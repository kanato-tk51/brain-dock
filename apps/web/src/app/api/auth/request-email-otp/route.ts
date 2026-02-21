import { compare } from "bcryptjs";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authBypassed, authRequired, getAllowedEmail } from "@/lib/auth-constants";
import { issueEmailOtpChallenge, sendEmailOtpCode } from "@/lib/email-otp";

export const runtime = "nodejs";
const sendRateLimit = new Map<string, number>();
const SEND_INTERVAL_MS = 30_000;

const requestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value) {
    return value;
  }
  if (authRequired()) {
    throw new Error(`${name} is required when authentication is enabled`);
  }
  return "";
}

export async function POST(request: Request) {
  if (authBypassed()) {
    return NextResponse.json({ ok: true, bypassed: true });
  }

  try {
    const body = requestSchema.parse(await request.json());
    const email = body.email.trim().toLowerCase();
    const allowedEmail = getAllowedEmail();

    if (email !== allowedEmail) {
      return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
    }

    const now = Date.now();
    const lastSentAt = sendRateLimit.get(email) ?? 0;
    if (now - lastSentAt < SEND_INTERVAL_MS) {
      return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    }

    const passwordHash = requiredEnv("BRAIN_DOCK_PASSWORD_BCRYPT");
    const passwordOk = await compare(body.password, passwordHash);
    if (!passwordOk) {
      return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
    }

    const authSecret = requiredEnv("NEXTAUTH_SECRET");
    const challenge = issueEmailOtpChallenge(email, authSecret);
    await sendEmailOtpCode({
      to: email,
      code: challenge.otpCode,
      expiresAtUtc: challenge.expiresAtUtc,
    });
    sendRateLimit.set(email, now);

    return NextResponse.json({
      ok: true,
      challengeToken: challenge.challengeToken,
      expiresAtUtc: challenge.expiresAtUtc,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    return NextResponse.json({ error: "otp_send_failed" }, { status: 500 });
  }
}
