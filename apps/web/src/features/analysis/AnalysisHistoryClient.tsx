"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { FactClaim } from "@/domain/schemas";
import { getRepository } from "@/infra/repository-singleton";
import { formatLocal, toLocalInputValue, toUtcIso } from "@/shared/utils/time";

const analysisStatusLabels = {
  queued: "待機",
  queued_retry: "再試行待ち",
  running: "実行中",
  succeeded: "成功",
  failed: "失敗",
  blocked: "機密ブロック",
} as const;

const modalityLabels = {
  fact: "事実",
  plan: "予定",
  hypothesis: "仮説",
  request: "要望",
  feeling: "感情",
} as const;

const polarityLabels = {
  affirm: "肯定",
  negate: "否定",
} as const;

function withinRange(valueUtc: string, fromUtc?: string, toUtc?: string): boolean {
  const valueMs = Date.parse(valueUtc);
  const fromMs = fromUtc ? Date.parse(fromUtc) : undefined;
  const toMs = toUtc ? Date.parse(toUtc) : undefined;
  if (!Number.isFinite(valueMs)) {
    return false;
  }
  if (fromMs !== undefined && Number.isFinite(fromMs) && valueMs < fromMs) {
    return false;
  }
  if (toMs !== undefined && Number.isFinite(toMs) && valueMs > toMs) {
    return false;
  }
  return true;
}

function defaultDateRange() {
  const to = new Date();
  const from = new Date(to);
  from.setMonth(from.getMonth() - 1);
  return {
    fromLocal: toLocalInputValue(from.toISOString()),
    toLocal: toLocalInputValue(to.toISOString()),
  };
}

function claimSummary(claim: FactClaim): string {
  return `${claim.subjectText} / ${claim.predicate} / ${claim.objectTextCanonical}`;
}

export function AnalysisHistoryClient() {
  const repo = useMemo(() => getRepository(), []);
  const { fromLocal, toLocal } = useMemo(() => defaultDateRange(), []);
  const [historyFromLocal, setHistoryFromLocal] = useState(fromLocal);
  const [historyToLocal, setHistoryToLocal] = useState(toLocal);
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [retryNotice, setRetryNotice] = useState<string | null>(null);

  const analysisJobsQuery = useQuery({
    queryKey: ["analysis-jobs"],
    queryFn: () => repo.listAnalysisJobs({ limit: 120 }),
  });

  const entriesQuery = useQuery({
    queryKey: ["analysis-history-entries"],
    queryFn: () => repo.listEntries({ limit: 1000 }),
  });

  const analysisRows = useMemo(() => {
    const fromUtc = historyFromLocal ? toUtcIso(historyFromLocal) : undefined;
    const toUtc = historyToLocal ? toUtcIso(historyToLocal) : undefined;
    return (analysisJobsQuery.data ?? []).filter((job) => withinRange(job.requestedAtUtc, fromUtc, toUtc));
  }, [analysisJobsQuery.data, historyFromLocal, historyToLocal]);

  const expandedJob = useMemo(
    () => analysisRows.find((job) => job.id === expandedJobId) ?? null,
    [analysisRows, expandedJobId],
  );
  const expandedEntryIds = useMemo(() => {
    if (!expandedJob) {
      return [];
    }
    return [...new Set(expandedJob.items.map((item) => item.entryId))];
  }, [expandedJob]);

  const factQueries = useQueries({
    queries: expandedEntryIds.map((entryId) => ({
      queryKey: ["facts-by-entry", entryId],
      queryFn: () => repo.listFactsByEntry(entryId, 40),
      enabled: Boolean(expandedJobId),
    })),
  });

  async function retryEntry(entryId: string) {
    try {
      const result = await repo.runAnalysisForEntries({
        entryIds: [entryId],
        replaceExisting: true,
        reasoningEffort: "none",
        priority: "high",
      });
      setRetryNotice(`再実行完了: 成功 ${result.succeeded} / 失敗 ${result.failed}`);
      await analysisJobsQuery.refetch();
    } catch (error) {
      setRetryNotice(error instanceof Error ? error.message : "再実行に失敗しました");
    }
  }

  const factsByEntry = useMemo(() => {
    const map = new Map<string, FactClaim[]>();
    for (let i = 0; i < expandedEntryIds.length; i += 1) {
      map.set(expandedEntryIds[i], factQueries[i]?.data ?? []);
    }
    return map;
  }, [expandedEntryIds, factQueries]);

  const entryPreviewById = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of entriesQuery.data ?? []) {
      const preview = entry.body?.trim() || JSON.stringify(entry.payload);
      map.set(entry.id, preview);
    }
    return map;
  }, [entriesQuery.data]);

  return (
    <div className="mx-auto max-w-7xl space-y-4 px-4 py-6">
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-white/40 bg-white/55 p-5">
          <div>
            <p className="text-xs uppercase tracking-widest text-ink/60">分析</p>
            <h1 className="text-xl font-bold">解析履歴</h1>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/insights"><Button variant="ghost">料金集計へ</Button></Link>
            <Link href="/"><Button variant="ghost">ホームへ戻る</Button></Link>
          </div>
        </div>

        <div className="rounded-2xl border border-white/40 bg-white/55 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-bold">解析ジョブ一覧</h2>
            <Button variant="ghost" onClick={() => analysisJobsQuery.refetch()}>再読み込み</Button>
          </div>

          <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
            <input
              type="datetime-local"
              value={historyFromLocal}
              onChange={(e) => setHistoryFromLocal(e.target.value)}
              className="w-full rounded-xl2 border border-[#d8d2c7] bg-white/80 px-3 py-2 text-sm"
            />
            <input
              type="datetime-local"
              value={historyToLocal}
              onChange={(e) => setHistoryToLocal(e.target.value)}
              className="w-full rounded-xl2 border border-[#d8d2c7] bg-white/80 px-3 py-2 text-sm"
            />
          </div>

          <div className="mt-3 space-y-2">
            {retryNotice ? <p className="rounded bg-white/75 px-2 py-1 text-xs text-ink/80">{retryNotice}</p> : null}
            {analysisRows.map((job) => {
              const expanded = expandedJobId === job.id;
              return (
                <div key={job.id} className="rounded-lg border border-[#d8d2c7] bg-white/70 px-3 py-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge>{analysisStatusLabels[job.status]}</Badge>
                      <Badge>{job.extractorVersion}</Badge>
                      <span className="text-ink/70">
                        成功 {job.succeededItems} / 失敗 {job.failedItems} / 全体 {job.totalItems}
                      </span>
                    </div>
                    <Button variant="ghost" onClick={() => setExpandedJobId(expanded ? null : job.id)}>
                      {expanded ? "詳細を閉じる" : "構造化結果を見る"}
                    </Button>
                  </div>
                  <p className="mt-1 text-ink/70">{formatLocal(job.requestedAtUtc)}</p>
                  <p className="mt-1 line-clamp-2 text-ink/85">job: {job.id}</p>

                  {expanded ? (
                    <div className="mt-3 space-y-3 border-t border-[#dfd7ca] pt-3">
                      {job.items.map((item) => {
                        const claims = factsByEntry.get(item.entryId) ?? [];
                        const preview = entryPreviewById.get(item.entryId) ?? "原文を取得できませんでした";
                        return (
                          <div key={item.id} className="rounded-xl2 border border-[#ddd5c8] bg-white/80 p-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge>{analysisStatusLabels[item.status]}</Badge>
                              <span className="text-ink/75">entry: {item.entryId}</span>
                              <span className="text-ink/75">claims: {item.claimsInserted}</span>
                              {item.extractionId ? <span className="text-ink/65">extraction: {item.extractionId}</span> : null}
                              {item.model ? <span className="text-ink/65">model: {item.model}</span> : null}
                            </div>
                            <p className="mt-2 text-[11px] text-ink/65">原文</p>
                            <p className="mt-1 rounded-lg bg-[#faf7f2] px-2 py-1 text-sm text-ink/90">{preview}</p>

                            {item.lastError ? (
                              <p className="mt-2 text-[11px] text-[#af5349]">error: {item.lastError}</p>
                            ) : null}
                            {(item.status === "failed" || item.status === "queued_retry" || item.status === "blocked") ? (
                              <div className="mt-2">
                                <Button variant="ghost" onClick={() => retryEntry(item.entryId)}>このentryを再実行</Button>
                              </div>
                            ) : null}

                            <div className="mt-2 space-y-2">
                              <p className="text-[11px] font-semibold text-ink/75">LLM解釈と保存構造</p>
                              {claims.length === 0 ? (
                                <p className="text-[11px] text-ink/60">このentryに保存済みclaimがありません。</p>
                              ) : null}
                              {claims.map((claim) => (
                                <div key={claim.id} className="rounded-lg border border-[#e3dccf] bg-white px-2 py-2">
                                  <p className="text-[11px] text-ink/90">{claimSummary(claim)}</p>
                                  <p className="mt-1 text-[11px] text-ink/70">
                                    解釈: {modalityLabels[claim.modality]} / {polarityLabels[claim.polarity]} / 確信度 {Math.round(claim.certainty * 100)}%
                                  </p>
                                  {claim.evidenceSpans.length > 0 ? (
                                    <div className="mt-1 space-y-1">
                                      {claim.evidenceSpans.slice(0, 2).map((span) => (
                                        <p key={span.id} className="rounded bg-[#f8f4ec] px-2 py-1 text-[11px] text-ink/75">
                                          根拠: {span.excerpt}
                                        </p>
                                      ))}
                                    </div>
                                  ) : null}
                                  <details className="mt-1">
                                    <summary className="cursor-pointer text-[11px] text-ink/70">構造(JSON)</summary>
                                    <pre className="mt-1 overflow-x-auto rounded bg-[#f7f3ea] p-2 text-[10px] text-ink/80">
                                      {JSON.stringify(claim, null, 2)}
                                    </pre>
                                  </details>
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {analysisRows.length === 0 ? <p className="text-xs text-ink/65">解析履歴データがありません。</p> : null}
          </div>
        </div>
      </section>
    </div>
  );
}
