"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useSession } from "next-auth/react";

type SessionGuardProps = {
  enabled: boolean;
};

export function SessionGuard({ enabled }: SessionGuardProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { status } = useSession();

  useEffect(() => {
    if (!enabled) {
      return;
    }
    if (status !== "unauthenticated") {
      return;
    }
    if (!pathname || pathname === "/login") {
      return;
    }
    const search = typeof window !== "undefined" ? window.location.search : "";
    const callbackUrl = search ? `${pathname}${search}` : pathname;
    router.replace(`/login?callbackUrl=${encodeURIComponent(callbackUrl)}`);
  }, [enabled, pathname, router, status]);

  return null;
}
