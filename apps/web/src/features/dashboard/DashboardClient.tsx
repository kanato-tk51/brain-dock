"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { EntryType, OpenAiPeriod } from "@/domain/schemas";
import { entryTypes } from "@/domain/schemas";
import { SimpleCaptureForm } from "@/features/capture/SimpleCaptureForm";
import { getRepository } from "@/infra/repository-singleton";
import { useUiStore } from "@/shared/state/ui-store";
import { formatLocal, toLocalInputValue, toUtcIso } from "@/shared/utils/time";
import { newUuidV7 } from "@/shared/utils/uuid";

const labels: Record<EntryType, string> = {
  journal: "日記",
  todo: "TODO",
  learning: "学び",
  thought: "思考",
  meeting: "会議",
};

const openAiPeriodLabels: Record<OpenAiPeriod, string> = {
  day: "日",
  week: "週",
  month: "月",
};
const analysisActionButtonClassName =
  "rounded-full border border-[#d8d2c7] bg-[#def5e1] px-2.5 py-1 text-xs font-medium text-ink hover:bg-[#cfe9d3]";

function formatUsd(value: number): string {
  return `$${value.toFixed(6)}`;
}

export function DashboardClient() {
  const repo = useMemo(() => getRepository(), []);
  const { searchText, filters, setSearchText, toggleType, setDateRange, setTags, clearFilters } =
    useUiStore();
  const [fromLocal, setFromLocal] = useState(filters.fromUtc ? toLocalInputValue(filters.fromUtc) : "");
  const [toLocal, setToLocal] = useState(filters.toUtc ? toLocalInputValue(filters.toUtc) : "");
  const [tagsInput, setTagsInput] = useState(filters.tags.join(","));
  const [openAiPeriod, setOpenAiPeriod] = useState<OpenAiPeriod>("day");
  const [openAiFromLocal, setOpenAiFromLocal] = useState(() =>
    toLocalInputValue(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()),
  );
  const [openAiToLocal, setOpenAiToLocal] = useState(() =>
    toLocalInputValue(new Date().toISOString()),
  );
  const [selectedEntryIds, setSelectedEntryIds] = useState<Set<string>>(new Set());
  const [analysisRunning, setAnalysisRunning] = useState(false);
  const [analysisNotice, setAnalysisNotice] = useState<string | null>(null);

  useEffect(() => {
    setFromLocal(filters.fromUtc ? toLocalInputValue(filters.fromUtc) : "");
    setToLocal(filters.toUtc ? toLocalInputValue(filters.toUtc) : "");
    setTagsInput(filters.tags.join(","));
  }, [filters.fromUtc, filters.toUtc, filters.tags]);

  const entriesQuery = useQuery({
    queryKey: ["entries", filters],
    queryFn: () => repo.listEntries({ ...filters, limit: 500 }),
  });

  const searchQuery = useQuery({
    queryKey: ["search", searchText, filters],
    enabled: searchText.trim().length > 0,
    queryFn: () => repo.searchEntries({ text: searchText, ...filters, limit: 200 }),
  });

  const openAiSummaryQuery = useQuery({
    queryKey: ["openai-summary", openAiPeriod, openAiFromLocal, openAiToLocal],
    queryFn: () =>
      repo.getOpenAiCostSummary({
        period: openAiPeriod,
        fromUtc: openAiFromLocal ? toUtcIso(openAiFromLocal) : undefined,
        toUtc: openAiToLocal ? toUtcIso(openAiToLocal) : undefined,
        limit: 120,
      }),
  });

  const openAiRequestsQuery = useQuery({
    queryKey: ["openai-requests", openAiFromLocal, openAiToLocal],
    queryFn: () =>
      repo.listOpenAiRequests({
        fromUtc: openAiFromLocal ? toUtcIso(openAiFromLocal) : undefined,
        toUtc: openAiToLocal ? toUtcIso(openAiToLocal) : undefined,
        limit: 30,
      }),
  });

  const entries = searchText.trim() ? searchQuery.data?.map((v) => v.entry) ?? [] : entriesQuery.data ?? [];
  const allVisibleSelected = entries.length > 0 && entries.every((entry) => selectedEntryIds.has(entry.id));

  const stats = useMemo(() => {
    const list = entriesQuery.data ?? [];
    const today = new Date().toISOString().slice(0, 10);
    const todayCount = list.filter((e) => e.occurredAtUtc.startsWith(today)).length;
    const pendingSync = list.filter((e) => e.syncStatus === "pending").length;
    const byType = Object.fromEntries(entryTypes.map((t) => [t, list.filter((e) => e.declaredType === t).length])) as Record<
      EntryType,
      number
    >;
    return { todayCount, pendingSync, byType };
  }, [entriesQuery.data]);

  async function runAnalysis(entryIds: string[]) {
    if (entryIds.length === 0) {
      return;
    }
    setAnalysisRunning(true);
    setAnalysisNotice(null);
    const targetEntryIds = new Set(entryIds);
    let summaryMessage = "";
    try {
      const result = await repo.runAnalysisForEntries({
        entryIds,
        extractor: "rules",
        replaceExisting: true,
      });
      summaryMessage = `解析完了: 成功 ${result.succeeded}件 / 失敗 ${result.failed}件`;

      const queue = await repo.listSyncQueue();
      const pendingTargets = queue.filter((item) => item.status === "pending" && targetEntryIds.has(item.entryId));
      let synced = 0;
      let syncFailed = 0;
      for (const item of pendingTargets) {
        try {
          await repo.markSynced(item.id, `remote-${newUuidV7()}`);
          synced += 1;
        } catch (error) {
          syncFailed += 1;
          const reason = error instanceof Error ? error.message : "sync error";
          try {
            await repo.markSyncFailed(item.id, reason);
          } catch {
            // keep loop alive
          }
        }
      }

      summaryMessage = `${summaryMessage} / 同期: 成功 ${synced}件 / 失敗 ${syncFailed}件`;
      setAnalysisNotice(summaryMessage);
      await entriesQuery.refetch();
      if (searchText.trim()) {
        await searchQuery.refetch();
      }
    } catch (error) {
      setAnalysisNotice(error instanceof Error ? error.message : "解析に失敗しました");
    } finally {
      setAnalysisRunning(false);
    }
  }

  return (
    <div className="mx-auto grid w-full max-w-7xl gap-4 px-4 py-5 lg:grid-cols-[1fr_320px]">
      <div className="space-y-4">
        <Card className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold">Timeline Dashboard</h1>
            </div>
            <Link href="/sync"><Button variant="ghost">Sync Queue</Button></Link>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Card className="bg-white/65 p-3">
              <p className="text-xs text-ink/60">今日の記録</p>
              <p className="text-2xl font-bold">{stats.todayCount}</p>
            </Card>
            <Card className="bg-white/65 p-3">
              <p className="text-xs text-ink/60">未Sync</p>
              <p className="text-2xl font-bold">{stats.pendingSync}</p>
            </Card>
            <Card className="bg-white/65 p-3">
              <p className="text-xs text-ink/60">タイプ内訳</p>
              <div className="mt-1 flex flex-wrap gap-2">
                {entryTypes.map((type) => (
                  <Badge key={type}>{labels[type]}:{stats.byType[type]}</Badge>
                ))}
              </div>
            </Card>
          </div>
        </Card>

        <Card className="p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-bold">Timeline</h2>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                onClick={() => {
                  if (allVisibleSelected) {
                    setSelectedEntryIds(new Set());
                    return;
                  }
                  setSelectedEntryIds(new Set(entries.map((entry) => entry.id)));
                }}
              >
                {allVisibleSelected ? "選択解除" : "全選択"}
              </Button>
              <Button
                onClick={() => runAnalysis(Array.from(selectedEntryIds))}
                disabled={analysisRunning || selectedEntryIds.size === 0}
                className={analysisActionButtonClassName}
              >
                {analysisRunning ? "解析中..." : `選択を解析 (${selectedEntryIds.size})`}
              </Button>
              <Button variant="ghost" onClick={clearFilters}>Filterクリア</Button>
            </div>
          </div>
          {analysisNotice ? (
            <p className="mb-3 rounded-xl2 bg-white/70 px-3 py-2 text-sm text-ink/85">{analysisNotice}</p>
          ) : null}

          <div className="mb-3 flex flex-wrap gap-2">
            {entryTypes.map((type) => {
              const active = filters.types.includes(type);
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => toggleType(type)}
                  className={`rounded-full border px-3 py-1 text-xs ${active ? "border-ink bg-ink text-cream" : "border-[#d3cbbd] bg-white/60 text-ink"}`}
                >
                  {labels[type]}
                </button>
              );
            })}
          </div>

          <div className="space-y-2">
            {entries.map((entry) => (
              <Card key={entry.id} className="bg-white/70 p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={selectedEntryIds.has(entry.id)}
                        onChange={(e) => {
                          setSelectedEntryIds((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) {
                              next.add(entry.id);
                            } else {
                              next.delete(entry.id);
                            }
                            return next;
                          });
                        }}
                      />
                      <p className="text-xs text-ink/60">{labels[entry.declaredType]} / {formatLocal(entry.occurredAtUtc)}</p>
                    </div>
                    <p className="mt-1 text-sm text-ink/85 line-clamp-3">{entry.body || JSON.stringify(entry.payload)}</p>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {entry.tags.map((tag) => <Badge key={tag}>#{tag}</Badge>)}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <Button
                      onClick={() => runAnalysis([entry.id])}
                      disabled={analysisRunning}
                      className={analysisActionButtonClassName}
                    >
                      解析実行
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
            {entries.length === 0 ? <p className="text-sm text-ink/70">データがありません。</p> : null}
          </div>
        </Card>
      </div>

      <div className="space-y-4">
        <Card className="p-5">
          <h2 className="text-base font-bold">検索</h2>
          <input
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="キーワード検索"
            className="mt-2 w-full rounded-xl2 border border-[#d8d2c7] bg-white/80 px-3 py-2 text-sm"
          />
          <p className="mt-2 text-xs text-ink/60">{"exact > prefix > contains + recency boost"}</p>
        </Card>

        <SimpleCaptureForm
          initialType="journal"
          embedded
          onSaved={async () => {
            await entriesQuery.refetch();
            if (searchText.trim()) {
              await searchQuery.refetch();
            }
          }}
        />

        <Card className="p-5">
          <h2 className="text-base font-bold">OpenAI API利用</h2>
          <div className="mt-2 flex flex-wrap gap-2">
            {(["day", "week", "month"] as const).map((period) => {
              const active = period === openAiPeriod;
              return (
                <button
                  key={period}
                  type="button"
                  onClick={() => setOpenAiPeriod(period)}
                  className={`rounded-full border px-3 py-1 text-xs ${active ? "border-ink bg-ink text-cream" : "border-[#d3cbbd] bg-white/60 text-ink"}`}
                >
                  {openAiPeriodLabels[period]}
                </button>
              );
            })}
          </div>
          <div className="mt-3 grid grid-cols-1 gap-2">
            <input
              type="datetime-local"
              value={openAiFromLocal}
              onChange={(e) => setOpenAiFromLocal(e.target.value)}
              className="w-full rounded-xl2 border border-[#d8d2c7] bg-white/80 px-3 py-2 text-sm"
            />
            <input
              type="datetime-local"
              value={openAiToLocal}
              onChange={(e) => setOpenAiToLocal(e.target.value)}
              className="w-full rounded-xl2 border border-[#d8d2c7] bg-white/80 px-3 py-2 text-sm"
            />
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <Card className="bg-white/65 p-2">
              <p className="text-ink/60">総コスト</p>
              <p className="mt-1 text-sm font-semibold">
                {formatUsd(openAiSummaryQuery.data?.totals.totalCostUsd ?? 0)}
              </p>
            </Card>
            <Card className="bg-white/65 p-2">
              <p className="text-ink/60">リクエスト数</p>
              <p className="mt-1 text-sm font-semibold">{openAiSummaryQuery.data?.totals.requestCount ?? 0}</p>
            </Card>
            <Card className="bg-white/65 p-2">
              <p className="text-ink/60">入力token</p>
              <p className="mt-1 text-sm font-semibold">{openAiSummaryQuery.data?.totals.inputTokens ?? 0}</p>
            </Card>
            <Card className="bg-white/65 p-2">
              <p className="text-ink/60">出力token</p>
              <p className="mt-1 text-sm font-semibold">{openAiSummaryQuery.data?.totals.outputTokens ?? 0}</p>
            </Card>
          </div>

          <div className="mt-4">
            <p className="text-xs font-semibold text-ink/80">期間別コスト</p>
            <div className="mt-2 space-y-1">
              {openAiSummaryQuery.data?.buckets.slice(0, 8).map((bucket) => (
                <div
                  key={bucket.periodStartUtc}
                  className="flex items-center justify-between rounded-lg border border-[#d8d2c7] bg-white/70 px-2 py-1 text-xs"
                >
                  <span>{formatLocal(bucket.periodStartUtc)}</span>
                  <span>{formatUsd(bucket.totalCostUsd)} / {bucket.requestCount} req</span>
                </div>
              ))}
              {(openAiSummaryQuery.data?.buckets.length ?? 0) === 0 ? (
                <p className="text-xs text-ink/65">集計データがありません。</p>
              ) : null}
            </div>
          </div>

          <div className="mt-4">
            <p className="text-xs font-semibold text-ink/80">最新リクエスト</p>
            <div className="mt-2 space-y-2">
              {openAiRequestsQuery.data?.slice(0, 8).map((row) => (
                <div key={row.id} className="rounded-lg border border-[#d8d2c7] bg-white/70 px-2 py-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{row.model}</span>
                    <Badge className={row.status === "ok" ? "bg-[#def5e1]" : "bg-[#ffe8e1]"}>{row.status}</Badge>
                  </div>
                  <p className="mt-1 text-ink/70">{formatLocal(row.requestStartedAtUtc)}</p>
                  <p className="mt-1 text-ink/75">{row.operation ?? row.workflow ?? row.endpoint}</p>
                  <p className="mt-1 text-ink/75">
                    {formatUsd(row.requestCostUsd)} / {row.totalTokens} tokens
                  </p>
                </div>
              ))}
              {(openAiRequestsQuery.data?.length ?? 0) === 0 ? (
                <p className="text-xs text-ink/65">履歴データがありません。</p>
              ) : null}
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <h3 className="text-sm font-semibold">Date range</h3>
          <div className="mt-2 grid grid-cols-1 gap-2">
            <input
              type="datetime-local"
              value={fromLocal}
              onChange={(e) => {
                const value = e.target.value;
                setFromLocal(value);
                setDateRange(value ? toUtcIso(value) : undefined, filters.toUtc);
              }}
              className="w-full rounded-xl2 border border-[#d8d2c7] bg-white/80 px-3 py-2 text-sm"
            />
            <input
              type="datetime-local"
              value={toLocal}
              onChange={(e) => {
                const value = e.target.value;
                setToLocal(value);
                setDateRange(filters.fromUtc, value ? toUtcIso(value) : undefined);
              }}
              className="w-full rounded-xl2 border border-[#d8d2c7] bg-white/80 px-3 py-2 text-sm"
            />
          </div>

          <h3 className="mt-4 text-sm font-semibold">Tags filter</h3>
          <input
            value={tagsInput}
            onChange={(e) => {
              const value = e.target.value;
              setTagsInput(value);
              setTags(
                value
                  .split(",")
                  .map((v) => v.trim())
                  .filter(Boolean),
              );
            }}
            placeholder="example: work,weekly"
            className="mt-2 w-full rounded-xl2 border border-[#d8d2c7] bg-white/80 px-3 py-2 text-sm"
          />
        </Card>
      </div>
    </div>
  );
}
