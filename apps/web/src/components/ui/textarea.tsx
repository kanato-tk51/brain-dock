import clsx from "clsx";
import type { TextareaHTMLAttributes } from "react";

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={clsx(
        "w-full rounded-xl2 border border-[#d8d2c7] bg-white/80 px-3 py-2 text-sm text-ink outline-none transition focus:border-ink focus:ring-2 focus:ring-ink/20",
        props.className,
      )}
    />
  );
}
