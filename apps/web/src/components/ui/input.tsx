import clsx from "clsx";
import type { InputHTMLAttributes } from "react";

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={clsx(
        "w-full rounded-xl2 border border-[#d8d2c7] bg-white/80 px-3 py-2 text-sm text-ink outline-none transition focus:border-ink focus:ring-2 focus:ring-ink/20",
        props.className,
      )}
    />
  );
}
