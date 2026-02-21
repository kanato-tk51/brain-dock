import clsx from "clsx";
import type { PropsWithChildren } from "react";

export function Card({ children, className }: PropsWithChildren<{ className?: string }>) {
  return (
    <section className={clsx("rounded-[18px] border border-white/40 bg-white/75 p-4 shadow-card backdrop-blur", className)}>
      {children}
    </section>
  );
}
