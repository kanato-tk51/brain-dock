const DEFAULT_ALLOWED_EMAIL = "k-takahashi@toggle.co.jp";

export function authRequired(): boolean {
  if (process.env.BRAIN_DOCK_REQUIRE_AUTH === "1") {
    return true;
  }
  return process.env.VERCEL === "1";
}

export function authBypassed(): boolean {
  return !authRequired();
}

export function getAllowedEmail(): string {
  return (process.env.BRAIN_DOCK_ALLOWED_EMAIL ?? DEFAULT_ALLOWED_EMAIL).trim().toLowerCase();
}

