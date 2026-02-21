import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SimpleCaptureForm } from "@/features/capture/SimpleCaptureForm";
import { DashboardClient } from "@/features/dashboard/DashboardClient";
import { resetDbForTests } from "@/infra/indexeddb";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
  }),
  usePathname: () => "/",
}));

function withProviders(node: React.ReactNode) {
  const query = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={query}>{node}</QueryClientProvider>;
}

describe("capture to timeline integration", () => {
  beforeEach(async () => {
    await resetDbForTests();
  });

  it("submits thought form and shows in timeline", async () => {
    render(withProviders(<SimpleCaptureForm initialType="thought" />));

    const typeSelect = screen.getByLabelText("入力タイプ");
    fireEvent.change(typeSelect, { target: { value: "thought" } });
    const memoBox = screen.getByLabelText("入力内容");
    fireEvent.change(memoBox, { target: { value: "次の改善案を試す" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(screen.getByText("保存しました")).toBeInTheDocument());

    render(withProviders(<DashboardClient />));
    await waitFor(() => expect(screen.getByText(/次の改善案を試す/)).toBeInTheDocument());
  });
});
