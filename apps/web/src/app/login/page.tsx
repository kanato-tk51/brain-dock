import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { LoginClient } from "@/features/auth/LoginClient";
import { authBypassed, getAllowedEmail } from "@/lib/auth-constants";
import { authOptions } from "@/lib/auth";

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
  const normalizedCallbackUrl = callbackUrl && callbackUrl.startsWith("/") ? callbackUrl : "/";

  const session = await getServerSession(authOptions);
  const sessionEmail = session?.user?.email?.toLowerCase() ?? "";
  if (sessionEmail && sessionEmail === getAllowedEmail()) {
    redirect(normalizedCallbackUrl);
  }

  return <LoginClient errorCode={errorCode} callbackUrl={normalizedCallbackUrl} />;
}
