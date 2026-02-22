"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { AnalysisReasoningEffort, EntryType } from "@/domain/schemas";
import { entryTypes } from "@/domain/schemas";
import { SimpleCaptureForm } from "@/features/capture/SimpleCaptureForm";
import { getRepository } from "@/infra/repository-singleton";
import { useUiStore } from "@/shared/state/ui-store";
import { formatLocal, toLocalInputValue, toUtcIso } from "@/shared/utils/time";

const labels: Record<EntryType, string> = {
  journal: "日記",
  todo: "TODO",
  learning: "学び",
  thought: "思考",
  meeting: "会議",
};

const analysisStateLabels = {
  not_requested: "未実行",
  queued: "要再試行",
  running: "実行中",
  succeeded: "成功",
  failed: "失敗",
  blocked: "機密ブロック",
} as const;

const analysisActionButtonClassName =
  "rounded-full border border-[#d8d2c7] bg-white px-2.5 py-1 text-xs font-medium text-ink hover:bg-[#f6f6f4]";

const analyzedBadgeClassName =
  "rounded-full border border-[#8ecf9c] bg-[#e8f7ec] px-2.5 py-1 text-xs font-medium text-[#1c6a2b]";

const reasoningEffortLabels: Record<AnalysisReasoningEffort, string> = {
  none: "なし",
  low: "低",
  medium: "中",
  high: "高",
};

export function DashboardClient() {
  const repo = useMemo(() => getRepository(), []);
  const { searchText, filters, setSearchText, toggleType, setDateRange, setTags, clearFilters } =
    useUiStore();
  const [fromLocal, setFromLocal] = useState(filters.fromUtc ? toLocalInputValue(filters.fromUtc) : "");
  const [toLocal, setToLocal] = useState(filters.toUtc ? toLocalInputValue(filters.toUtc) : "");
  const [tagsInput, setTagsInput] = useState(filters.tags.join(","));
  const [selectedEntryIds, setSelectedEntryIds] = useState<Set<string>>(new Set());
  const [analysisRunning, setAnalysisRunning] = useState(false);
  const [analysisNotice, setAnalysisNotice] = useState<string | null>(null);
  const [analysisModel, setAnalysisModel] = useState<string>("gpt-4.1-mini");
  const [analysisReasoningEffort, setAnalysisReasoningEffort] = useState<AnalysisReasoningEffort>("none");

  useEffect(() => {
    setFromLocal(filters.fromUtc ? toLocalInputValue(filters.fromUtc) : "");
    setToLocal(filters.toUtc ? toLocalInputValue(filters.toUtc) : "");
    setTagsInput(filters.tags.join(","));
  }, [filters.fromUtc, filters.toUtc, filters.tags]);

  const modelsQuery = useQuery({
    queryKey: ["analysis-models"],
    queryFn: () => repo.getAnalysisModels(),
  });

  useEffect(() => {
    const models = modelsQuery.data ?? [];
    if (models.length === 0) {
      return;
    }
    if (!models.some((model) => model.id === analysisModel)) {
      setAnalysisModel(models[0].id);
      setAnalysisReasoningEffort(models[0].defaultReasoningEffort);
      return;
    }
    const selected = models.find((model) => model.id === analysisModel);
    if (selected && !selected.supportsReasoningEffort && analysisReasoningEffort !== "none") {
      setAnalysisReasoningEffort("none");
    }
  }, [analysisModel, analysisReasoningEffort, modelsQuery.data]);

  const entriesQuery = useQuery({
    queryKey: ["entries", filters],
    queryFn: () => repo.listEntries({ ...filters, limit: 500 }),
  });

  const searchQuery = useQuery({
    queryKey: ["search", searchText, filters],
    enabled: searchText.trim().length > 0,
    queryFn: () => repo.searchEntries({ text: searchText, ...filters, limit: 200 }),
  });

  const entries = searchText.trim() ? searchQuery.data?.map((v) => v.entry) ?? [] : entriesQuery.data ?? [];
  const allVisibleSelected = entries.length > 0 && entries.every((entry) => selectedEntryIds.has(entry.id));

  const stats = useMemo(() => {
    const list = entriesQuery.data ?? [];
    const today = new Date().toISOString().slice(0, 10);
    const todayCount = list.filter((e) => e.occurredAtUtc.startsWith(today)).length;
    const readyToAnalyze = list.filter((e) => e.analysisState === "not_requested" || e.analysisState === "failed").length;
    const byType = Object.fromEntries(entryTypes.map((t) => [t, list.filter((e) => e.declaredType === t).length])) as Record<
      EntryType,
      number
    >;
    return { todayCount, readyToAnalyze, byType };
  }, [entriesQuery.data]);

  async function runAnalysis(entryIds: string[]) {
    if (entryIds.length === 0) {
      return;
    }
    setAnalysisRunning(true);
    setAnalysisNotice(null);
    try {
      const selected = (modelsQuery.data ?? []).find((model) => model.id === analysisModel);
      const effectiveReasoning = selected?.supportsReasoningEffort ? analysisReasoningEffort : "none";
      const result = await repo.runAnalysisForEntries({
        entryIds,
        replaceExisting: true,
        llmModel: analysisModel,
        reasoningEffort: effectiveReasoning,
        priority: "normal",
      });
      setAnalysisNotice(
        `解析完了 (job: ${result.jobId}): 成功 ${result.succeeded}件 / 失敗 ${result.failed}件 / model: ${analysisModel} / reasoning: ${effectiveReasoning}`,
      );
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
              <h1 className="text-2xl font-bold">タイムライン</h1>
            </div>
            <div className="flex items-center gap-2">
              <Link href="/facts"><Button variant="ghost">ファクト</Button></Link>
              <Link href="/analysis-history"><Button variant="ghost">解析履歴</Button></Link>
              <Link href="/insights"><Button variant="ghost">料金</Button></Link>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Card className="bg-white/65 p-3">
              <p className="text-xs text-ink/60">今日の記録</p>
              <p className="text-2xl font-bold">{stats.todayCount}</p>
            </Card>
            <Card className="bg-white/65 p-3">
              <p className="text-xs text-ink/60">解析待ち</p>
              <p className="text-2xl font-bold">{stats.readyToAnalyze}</p>
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
            <h2 className="text-lg font-bold">投稿一覧</h2>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1 rounded-xl2 border border-[#d8d2c7] bg-white/70 px-2 py-1">
                <label htmlFor="analysis-model" className="text-xs text-ink/70">モデル</label>
                <select
                  id="analysis-model"
                  value={analysisModel}
                  onChange={(e) => setAnalysisModel(e.target.value)}
                  className="bg-transparent text-xs text-ink focus:outline-none"
                >
                  {(modelsQuery.data ?? []).map((model) => (
                    <option key={model.id} value={model.id}>{model.id}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-1 rounded-xl2 border border-[#d8d2c7] bg-white/70 px-2 py-1">
                <label htmlFor="analysis-reasoning" className="text-xs text-ink/70">reasoning</label>
                <select
                  id="analysis-reasoning"
                  value={analysisReasoningEffort}
                  onChange={(e) => setAnalysisReasoningEffort(e.target.value as AnalysisReasoningEffort)}
                  className="bg-transparent text-xs text-ink focus:outline-none"
                >
                  {Object.entries(reasoningEffortLabels).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </div>
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
                variant="unstyled"
                onClick={() => runAnalysis(Array.from(selectedEntryIds))}
                disabled={analysisRunning || selectedEntryIds.size === 0}
                className={analysisActionButtonClassName}
              >
                {analysisRunning ? "解析中..." : `選択を解析 (${selectedEntryIds.size})`}
              </Button>
              <Button variant="ghost" onClick={clearFilters}>絞り込み解除</Button>
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
                      <span className="text-[10px] text-ink/60">{analysisStateLabels[entry.analysisState as AnalysisStatus] ?? "未実行"}</span>
                    </div>
                    <p className="mt-1 text-sm text-ink/85 line-clamp-3">{entry.body || JSON.stringify(entry.payload)}</p>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {entry.tags.map((tag) => <Badge key={tag}>#{tag}</Badge>)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {entry.analysisState === "succeeded" ? (
                      <span className={analyzedBadgeClassName}>解析済</span>
                    ) : null}
                    <Button
                      variant="unstyled"
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
          <p className="mt-2 text-xs text-ink/60">{"完全一致 > 前方一致 > 部分一致 + 新しさ補正"}</p>
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
          <h3 className="text-sm font-semibold">日時範囲</h3>
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

          <h3 className="mt-4 text-sm font-semibold">タグ絞り込み</h3>
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
            placeholder="例: work,weekly"
            className="mt-2 w-full rounded-xl2 border border-[#d8d2c7] bg-white/80 px-3 py-2 text-sm"
          />
        </Card>
      </div>
    </div>
  );
}

type AnalysisStatus = keyof typeof analysisStateLabels;
