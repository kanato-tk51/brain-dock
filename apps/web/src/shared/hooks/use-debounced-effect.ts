"use client";

import { useEffect } from "react";

export function useDebouncedEffect(effect: () => void, deps: unknown[], delayMs: number) {
  useEffect(() => {
    const timer = setTimeout(effect, delayMs);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, delayMs]);
}
