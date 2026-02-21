"use client";

import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";

function resolveErrorMessage(errorCode?: string): string | null {
  if (!errorCode) {
    return null;
  }
  if (errorCode === "AccessDenied" || errorCode === "CredentialsSignin") {
    return "メール・パスワード・認証コードを確認してください。";
  }
  return "ログインに失敗しました。時間をおいて再実行してください。";
}

type LoginClientProps = {
  allowedEmail: string;
  errorCode?: string;
  callbackUrl?: string;
};

export function LoginClient({ allowedEmail, errorCode, callbackUrl }: LoginClientProps) {
  const router = useRouter();
  const [phase, setPhase] = useState<"credentials" | "otp">("credentials");
  const [email, setEmail] = useState(allowedEmail);
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [challengeToken, setChallengeToken] = useState("");
  const [expiresAtUtc, setExpiresAtUtc] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(resolveErrorMessage(errorCode));
  const [noticeMessage, setNoticeMessage] = useState<string | null>(null);

  const normalizedCallbackUrl = callbackUrl && callbackUrl.startsWith("/") ? callbackUrl : "/";

  async function requestOtpCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setErrorMessage(null);
    setNoticeMessage(null);

    try {
      const response = await fetch("/api/auth/request-email-otp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email,
          password,
        }),
      });
      const payload = (await response.json()) as {
        ok?: boolean;
        challengeToken?: string;
        expiresAtUtc?: string;
        bypassed?: boolean;
        error?: string;
      };

      if (!response.ok || !payload.ok || !payload.challengeToken) {
        if (payload.error === "rate_limited") {
          setErrorMessage("短時間で再送が多すぎます。30秒ほど待ってから再試行してください。");
        } else {
          setErrorMessage("メールまたはパスワードが正しくありません。");
        }
        setSubmitting(false);
        return;
      }

      setChallengeToken(payload.challengeToken);
      setExpiresAtUtc(payload.expiresAtUtc ?? null);
      setPhase("otp");
      setNoticeMessage("認証コードをメールで送信しました。受信した6桁コードを入力してください。");
      setSubmitting(false);
    } catch {
      setErrorMessage("認証コード送信に失敗しました。時間をおいて再試行してください。");
      setSubmitting(false);
    }
  }

  async function verifyOtpAndLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setErrorMessage(null);
    setNoticeMessage(null);

    const result = await signIn("credentials", {
      redirect: false,
      email,
      otp,
      challengeToken,
      callbackUrl: normalizedCallbackUrl,
    });

    if (result?.ok) {
      router.push(normalizedCallbackUrl);
      router.refresh();
      return;
    }

    setErrorMessage(resolveErrorMessage(result?.error ?? "CredentialsSignin"));
    setSubmitting(false);
  }

  return (
    <div className="mx-auto flex min-h-[calc(100vh-64px)] w-full max-w-md items-center px-4 py-8">
      <div className="w-full rounded-2xl border border-white/40 bg-white/65 p-6">
        <h1 className="text-2xl font-bold">ログイン</h1>
        <p className="mt-2 text-sm text-ink/75">1. メール/パスワード確認 → 2. メール認証コード入力</p>

        <form className="mt-4 space-y-3" onSubmit={phase === "credentials" ? requestOtpCode : verifyOtpAndLogin}>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-ink/70">メール</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-xl2 border border-[#d8d2c7] bg-white/90 px-3 py-2 text-sm"
              autoComplete="username"
              disabled={phase === "otp"}
              required
            />
          </label>

          {phase === "credentials" ? (
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-ink/70">パスワード</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-xl2 border border-[#d8d2c7] bg-white/90 px-3 py-2 text-sm"
                autoComplete="current-password"
                required
              />
            </label>
          ) : (
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-ink/70">メールに届いた6桁コード</span>
              <input
                type="text"
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
                className="w-full rounded-xl2 border border-[#d8d2c7] bg-white/90 px-3 py-2 text-sm"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                autoComplete="one-time-code"
                required
              />
            </label>
          )}

          {noticeMessage ? <p className="rounded-xl2 bg-mint/35 px-3 py-2 text-sm text-ink">{noticeMessage}</p> : null}
          {phase === "otp" && expiresAtUtc ? (
            <p className="text-xs text-ink/70">有効期限 (UTC): {expiresAtUtc}</p>
          ) : null}
          {errorMessage ? <p className="rounded-xl2 bg-coral/20 px-3 py-2 text-sm text-ink">{errorMessage}</p> : null}
          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? "処理中..." : phase === "credentials" ? "認証コードを送信" : "ログインを完了"}
          </Button>
          {phase === "otp" ? (
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={() => {
                setPhase("credentials");
                setOtp("");
                setChallengeToken("");
                setNoticeMessage(null);
              }}
              disabled={submitting}
            >
              最初からやり直す
            </Button>
          ) : null}
        </form>
      </div>
    </div>
  );
}
