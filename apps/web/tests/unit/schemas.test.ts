import { describe, expect, it } from "vitest";
import { validatePayload } from "@/domain/schemas";

describe("schema validation", () => {
  it("validates required fields by type", () => {
    expect(() => validatePayload("journal", { reflection: "today" })).not.toThrow();
    expect(() => validatePayload("journal", { reflection: "" })).toThrow();

    expect(() => validatePayload("todo", { details: "task", status: "todo", priority: 3 })).not.toThrow();
    expect(() => validatePayload("todo", { details: "" })).toThrow();

    expect(() =>
      validatePayload("meeting", {
        context: "weekly",
        notes: "discussion",
        decisions: ["go"],
        actions: ["write memo"],
      }),
    ).not.toThrow();
  });
});
