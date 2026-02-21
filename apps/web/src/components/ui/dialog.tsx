import type { PropsWithChildren } from "react";
import { Button } from "@/components/ui/button";

type Props = PropsWithChildren<{
  open: boolean;
  title: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel?: string;
}>;

export function Dialog({
  open,
  title,
  children,
  onConfirm,
  onCancel,
  confirmLabel = "保存する",
}: Props) {
  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4">
      <div className="w-full max-w-lg rounded-[20px] border border-white/20 bg-cream p-5 shadow-2xl">
        <h2 className="text-lg font-bold text-ink">{title}</h2>
        <div className="mt-3 text-sm text-ink/90">{children}</div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            キャンセル
          </Button>
          <Button onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </div>
    </div>
  );
}
