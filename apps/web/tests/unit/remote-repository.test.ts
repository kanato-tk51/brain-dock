import { beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteRepository } from "@/infra/remote-repository";

describe("remote repository", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("calls API to capture/list/search entries", async () => {
    const repo = new RemoteRepository("http://localhost:8787");
    const baseEntry = {
      id: "018ecf2e-8f8a-7b94-a112-2f0a96d1d000",
      declaredType: "thought",
      body: "本文",
      tags: [],
      occurredAtUtc: "2026-02-21T10:00:00.000Z",
      sensitivity: "internal",
      createdAtUtc: "2026-02-21T10:00:00.000Z",
      updatedAtUtc: "2026-02-21T10:00:00.000Z",
      analysisState: "not_requested",
      payload: { note: "メモ" },
    };

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(baseEntry), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([baseEntry]), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ entry: baseEntry, score: 1.2, matchedFields: ["payload"] }]), { status: 200 }),
      );

    const created = await repo.captureText({
      declaredType: "thought",
      text: "本文",
    });
    expect(created.id).toBe(baseEntry.id);

    const list = await repo.listEntries({ limit: 10 });
    expect(list).toHaveLength(1);

    const search = await repo.searchEntries({ text: "メモ", limit: 10 });
    expect(search).toHaveLength(1);
  });

  it("fetches analysis models and runs analysis job", async () => {
    const repo = new RemoteRepository("http://localhost:8787");

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: "gpt-4.1-mini",
              label: "GPT-4.1 mini",
              supportsReasoningEffort: false,
              defaultReasoningEffort: "none",
            },
          ]),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jobId: "018ecf2e-8f8a-7b94-a112-2f0a96d1d999",
            requested: 1,
            succeeded: 1,
            failed: 0,
            replaceExisting: true,
            results: [
              {
                entryId: "018ecf2e-8f8a-7b94-a112-2f0a96d1d001",
                status: "succeeded",
                claimsInserted: 3,
                attemptCount: 1,
              },
            ],
          }),
          { status: 200 },
        ),
      );

    const models = await repo.getAnalysisModels();
    expect(models).toHaveLength(1);

    const result = await repo.runAnalysisForEntries({
      entryIds: ["018ecf2e-8f8a-7b94-a112-2f0a96d1d001"],
      replaceExisting: true,
      priority: "normal",
    });
    expect(result.succeeded).toBe(1);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://localhost:8787/analysis/models",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://localhost:8787/analysis/jobs",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("fetches openai request history and summary", async () => {
    const repo = new RemoteRepository("http://localhost:8787");
    const requestRow = {
      id: "req-1",
      createdAtUtc: "2026-02-21T10:00:00.000Z",
      requestStartedAtUtc: "2026-02-21T10:00:00.000Z",
      requestFinishedAtUtc: "2026-02-21T10:00:01.000Z",
      status: "ok",
      environment: "local",
      endpoint: "/chat/completions",
      model: "gpt-4.1-mini",
      operation: "extract_claims_llm",
      workflow: "worker",
      actor: "worker:extract_claims_llm",
      sourceRefType: "entry",
      inputTokens: 120,
      cachedInputTokens: 0,
      outputTokens: 60,
      reasoningOutputTokens: 0,
      totalTokens: 180,
      requestCostUsd: 0.000144,
      costSource: "estimated",
    };
    const summaryRow = {
      period: "day",
      totals: {
        requestCount: 1,
        okCount: 1,
        errorCount: 0,
        inputTokens: 120,
        cachedInputTokens: 0,
        outputTokens: 60,
        totalTokens: 180,
        totalCostUsd: 0.000144,
      },
      buckets: [
        {
          period: "day",
          periodStartUtc: "2026-02-21T00:00:00.000Z",
          requestCount: 1,
          okCount: 1,
          errorCount: 0,
          inputTokens: 120,
          cachedInputTokens: 0,
          outputTokens: 60,
          totalTokens: 180,
          totalCostUsd: 0.000144,
        },
      ],
    };

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify([requestRow]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(summaryRow), { status: 200 }));

    const requests = await repo.listOpenAiRequests({ limit: 10 });
    expect(requests).toHaveLength(1);
    expect(requests[0].model).toBe("gpt-4.1-mini");

    const summary = await repo.getOpenAiCostSummary({ period: "day", limit: 30 });
    expect(summary.totals.totalCostUsd).toBeCloseTo(0.000144);
  });
});
