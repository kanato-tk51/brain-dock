import { redirect } from "next/navigation";
import { LoginClient } from "@/features/auth/LoginClient";
import { authBypassed } from "@/lib/auth-constants";

type LoginPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  if (authBypassed()) {
    redirect("/");
  }

  const resolved = searchParams ? await searchParams : undefined;
  const raw = resolved?.error;
  const errorCode = Array.isArray(raw) ? raw[0] : raw;
  const callbackRaw = resolved?.callbackUrl;
  const callbackUrl = Array.isArray(callbackRaw) ? callbackRaw[0] : callbackRaw;

  return <LoginClient errorCode={errorCode} callbackUrl={callbackUrl} />;
}
