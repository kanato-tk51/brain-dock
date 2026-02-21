import crypto from "node:crypto";
import nodemailer from "nodemailer";

type EmailOtpChallengePayload = {
  email: string;
  otpHash: string;
  exp: number;
  nonce: string;
};

type VerifyEmailOtpInput = {
  email: string;
  otp: string;
  challengeToken: string;
  secret: string;
};

const usedNonce = new Map<string, number>();
const failedAttempts = new Map<string, { count: number; exp: number }>();
const MAX_FAILED_ATTEMPTS = 5;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function cleanupExpiredNonces(now: number): void {
  for (const [nonce, exp] of usedNonce.entries()) {
    if (exp <= now) {
      usedNonce.delete(nonce);
    }
  }
  for (const [nonce, value] of failedAttempts.entries()) {
    if (value.exp <= now) {
      failedAttempts.delete(nonce);
    }
  }
}

function base64urlEncode(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function base64urlDecode(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

function signPayload(encodedPayload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

function secureEqualString(left: string, right: string): boolean {
  const leftBuf = Buffer.from(left);
  const rightBuf = Buffer.from(right);
  if (leftBuf.length !== rightBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuf, rightBuf);
}

function hashOtp(secret: string, otp: string): string {
  return crypto.createHash("sha256").update(`${secret}:${otp}`).digest("hex");
}

function emailOtpTtlSeconds(): number {
  const raw = Number(process.env.BRAIN_DOCK_EMAIL_OTP_TTL_SECONDS ?? 300);
  if (Number.isFinite(raw) && raw >= 60 && raw <= 1800) {
    return Math.trunc(raw);
  }
  return 300;
}

export function issueEmailOtpChallenge(email: string, secret: string): {
  challengeToken: string;
  otpCode: string;
  expiresAtUtc: string;
} {
  const otpCode = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const exp = nowSeconds() + emailOtpTtlSeconds();
  const payload: EmailOtpChallengePayload = {
    email: email.toLowerCase(),
    otpHash: hashOtp(secret, otpCode),
    exp,
    nonce: crypto.randomUUID(),
  };
  const encodedPayload = base64urlEncode(JSON.stringify(payload));
  const signature = signPayload(encodedPayload, secret);
  const challengeToken = `${encodedPayload}.${signature}`;
  return {
    challengeToken,
    otpCode,
    expiresAtUtc: new Date(exp * 1000).toISOString(),
  };
}

function parseChallengeToken(challengeToken: string, secret: string): EmailOtpChallengePayload | null {
  const separator = challengeToken.lastIndexOf(".");
  if (separator <= 0) {
    return null;
  }
  const encodedPayload = challengeToken.slice(0, separator);
  const signature = challengeToken.slice(separator + 1);
  const expectedSignature = signPayload(encodedPayload, secret);
  if (!secureEqualString(signature, expectedSignature)) {
    return null;
  }
  try {
    return JSON.parse(base64urlDecode(encodedPayload)) as EmailOtpChallengePayload;
  } catch {
    return null;
  }
}

export function verifyEmailOtpChallenge(input: VerifyEmailOtpInput): boolean {
  const now = nowSeconds();
  cleanupExpiredNonces(now);

  const payload = parseChallengeToken(input.challengeToken, input.secret);
  if (!payload) {
    return false;
  }
  if (payload.exp < now) {
    return false;
  }
  if (payload.email !== input.email.toLowerCase()) {
    return false;
  }
  if (usedNonce.has(payload.nonce)) {
    return false;
  }
  const attempts = failedAttempts.get(payload.nonce);
  if (attempts && attempts.count >= MAX_FAILED_ATTEMPTS) {
    return false;
  }

  const otpHash = hashOtp(input.secret, input.otp);
  if (!secureEqualString(otpHash, payload.otpHash)) {
    failedAttempts.set(payload.nonce, {
      count: (attempts?.count ?? 0) + 1,
      exp: payload.exp,
    });
    return false;
  }

  failedAttempts.delete(payload.nonce);
  usedNonce.set(payload.nonce, payload.exp);
  return true;
}

function smtpPort(): number {
  const raw = Number(process.env.BRAIN_DOCK_SMTP_PORT ?? 587);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 587;
  }
  return Math.trunc(raw);
}

function smtpSecure(port: number): boolean {
  if (process.env.BRAIN_DOCK_SMTP_SECURE === "1") {
    return true;
  }
  if (process.env.BRAIN_DOCK_SMTP_SECURE === "0") {
    return false;
  }
  return port === 465;
}

function requiredSmtpEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required to send login OTP email`);
  }
  return value;
}

export async function sendEmailOtpCode(params: {
  to: string;
  code: string;
  expiresAtUtc: string;
}): Promise<void> {
  const host = requiredSmtpEnv("BRAIN_DOCK_SMTP_HOST");
  const port = smtpPort();
  const secure = smtpSecure(port);
  const user = requiredSmtpEnv("BRAIN_DOCK_SMTP_USER");
  const pass = requiredSmtpEnv("BRAIN_DOCK_SMTP_PASS");
  const from = requiredSmtpEnv("BRAIN_DOCK_SMTP_FROM");

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });

  const subject = "Brain Dock ログイン認証コード";
  const text = [
    "Brain Dock のログイン認証コードです。",
    `コード: ${params.code}`,
    `有効期限(UTC): ${params.expiresAtUtc}`,
    "このコードに心当たりがない場合は破棄してください。",
  ].join("\n");

  await transporter.sendMail({
    from,
    to: params.to,
    subject,
    text,
  });
}
