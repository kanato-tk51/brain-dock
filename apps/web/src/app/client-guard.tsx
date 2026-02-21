"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { getRepository } from "@/infra/repository-singleton";
import { useSessionStore } from "@/shared/state/session-store";

export function ClientGuard() {
  const router = useRouter();
  const pathname = usePathname();
  const { checked, isLocked, setLockState, markChecked } = useSessionStore();

  useEffect(() => {
    const repo = getRepository();
    repo
      .isLocked()
      .then((locked) => setLockState(locked))
      .catch(() => markChecked());
  }, [setLockState, markChecked]);

  useEffect(() => {
    if (!checked) {
      return;
    }
    if (isLocked && pathname !== "/lock") {
      router.replace("/lock");
      return;
    }
    if (!isLocked && pathname === "/lock") {
      router.replace("/");
    }
  }, [checked, isLocked, pathname, router]);

  return null;
}
