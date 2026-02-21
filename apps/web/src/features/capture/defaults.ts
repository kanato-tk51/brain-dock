import type { EntryType } from "@/domain/schemas";
import { nowUtcIso, toLocalInputValue } from "@/shared/utils/time";

export type CaptureFormState = {
  title: string;
  body: string;
  tags: string;
  sensitivity: "public" | "internal" | "sensitive";
  occurredAtLocal: string;
  payload: Record<string, unknown>;
};

export function defaultPayload(type: EntryType): Record<string, unknown> {
  switch (type) {
    case "journal":
      return { mood: 3, energy: 3, reflection: "" };
    case "todo":
      return { status: "todo", priority: 3, dueAtLocal: "", context: "", details: "" };
    case "learning":
      return { url: "", summary3Lines: "", takeaway: "" };
    case "thought":
      return { hypothesis: "", question: "", note: "" };
    case "meeting":
      return { context: "", notes: "", decisions: "", actions: "" };
    case "wishlist":
      return { item: "", reason: "", priority: 3, targetPrice: "" };
    default:
      return {};
  }
}

export function defaultForm(type: EntryType): CaptureFormState {
  return {
    title: "",
    body: "",
    tags: "",
    sensitivity: "internal",
    occurredAtLocal: toLocalInputValue(nowUtcIso()),
    payload: defaultPayload(type),
  };
}
