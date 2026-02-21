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
    return "メールまたはパスワードを確認してください。";
  }
  return "ログインに失敗しました。時間をおいて再実行してください。";
}

type LoginClientProps = {
  errorCode?: string;
  callbackUrl?: string;
};

export function LoginClient({ errorCode, callbackUrl }: LoginClientProps) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(resolveErrorMessage(errorCode));

  const normalizedCallbackUrl = callbackUrl && callbackUrl.startsWith("/") ? callbackUrl : "/";

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setErrorMessage(null);

    const result = await signIn("credentials", {
      redirect: false,
      email,
      password,
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
        <p className="mt-2 text-sm text-ink/75">メールとパスワードでログインしてください。</p>

        <form className="mt-4 space-y-3" onSubmit={onSubmit}>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-ink/70">メール</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-xl2 border border-[#d8d2c7] bg-white/90 px-3 py-2 text-sm"
              autoComplete="username"
              required
            />
          </label>

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

          {errorMessage ? <p className="rounded-xl2 bg-coral/20 px-3 py-2 text-sm text-ink">{errorMessage}</p> : null}
          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? "ログイン中..." : "ログイン"}
          </Button>
        </form>
      </div>
    </div>
  );
}
