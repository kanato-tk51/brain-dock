import type { ButtonHTMLAttributes, PropsWithChildren } from "react";
import clsx from "clsx";

type Props = PropsWithChildren<ButtonHTMLAttributes<HTMLButtonElement>> & {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "unstyled";
};

const styles: Record<NonNullable<Props["variant"]>, string> = {
  primary:
    "bg-ink text-cream hover:bg-[#1b232b] border border-ink",
  secondary:
    "bg-mint text-ink hover:bg-[#b7ebbc] border border-[#95d89a]",
  ghost:
    "bg-transparent text-ink hover:bg-white/60 border border-white/30",
  danger:
    "bg-coral text-white hover:bg-[#e76d47] border border-[#d55f3a]",
  unstyled: "",
};

export function Button({ children, className, variant = "primary", ...props }: Props) {
  return (
    <button
      className={clsx(
        "rounded-xl2 px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50",
        styles[variant],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
