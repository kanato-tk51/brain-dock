"use client";

import { signOut, useSession } from "next-auth/react";
import { Button } from "@/components/ui/button";

export function AuthStatus() {
  const { data, status } = useSession();
  if (status !== "authenticated") {
    return null;
  }

  return (
    <div className="flex items-center gap-2">
      <span className="hidden text-xs text-ink/70 sm:inline">{data.user?.email}</span>
      <Button variant="ghost" onClick={() => signOut({ callbackUrl: "/login" })}>
        ログアウト
      </Button>
    </div>
  );
}

