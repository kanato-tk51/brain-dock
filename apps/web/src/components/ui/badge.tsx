import clsx from "clsx";
import type { PropsWithChildren } from "react";

export function Badge({ children, className }: PropsWithChildren<{ className?: string }>) {
  return (
    <span
      className={clsx(
        "inline-flex rounded-full border border-[#d8d2c7] bg-white/70 px-2.5 py-1 text-xs font-medium text-ink",
        className,
      )}
    >
      {children}
    </span>
  );
}
