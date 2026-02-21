"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { EntryType, HistoryRecord, OpenAiPeriod } from "@/domain/schemas";
import { getRepository } from "@/infra/repository-singleton";
import { formatLocal, toLocalInputValue, toUtcIso } from "@/shared/utils/time";

const openAiPeriodLabels: Record<OpenAiPeriod, string> = {
  day: "日",
  week: "週",
  month: "月",
};

const typeLabels: Record<EntryType, string> = {
  journal: "日記",
  todo: "TODO",
  learning: "学び",
  thought: "思考",
  meeting: "会議",
};

const sourceLabels: Record<"local" | "remote", string> = {
  local: "ローカル",
  remote: "リモート",
};

const syncStatusLabels: Record<"pending" | "syncing" | "synced" | "failed", string> = {
  pending: "未同期",
  syncing: "同期中",
  synced: "同期済み",
  failed: "同期失敗",
};

function formatUsd(value: number): string {
  return `$${value.toFixed(6)}`;
}

type HistorySummary = {
  id: string;
  createdAtUtc: string;
  sourceLabel: string;
  typeLabel: string;
  preview: string;
  fromStatusLabel: string;
  toStatusLabel: string;
};

function parseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function pickPreview(snapshot: Record<string, unknown> | null): string {
  if (!snapshot) {
    return "-";
  }
  if (typeof snapshot.body === "string" && snapshot.body.trim()) {
    return snapshot.body.trim();
  }
  const payload = snapshot.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const payloadObject = payload as Record<string, unknown>;
    const keys = ["details", "takeaway", "note", "reflection", "context", "notes"];
    for (const key of keys) {
      const value = payloadObject[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  }
  return "-";
}

function summarizeHistory(row: HistoryRecord): HistorySummary {
  const before = parseJson(row.beforeJson);
  const after = parseJson(row.afterJson);
  const declaredTypeRaw = (after?.declaredType ?? before?.declaredType) as EntryType | undefined;
  const typeLabel = declaredTypeRaw && declaredTypeRaw in typeLabels ? typeLabels[declaredTypeRaw] : "不明";
  const afterPreview = pickPreview(after);
  const preview = afterPreview !== "-" ? afterPreview : pickPreview(before);
  const fromStatus = typeof before?.syncStatus === "string" ? before.syncStatus : "-";
  const toStatus = typeof after?.syncStatus === "string" ? after.syncStatus : "-";
  return {
    id: row.id,
    createdAtUtc: row.createdAtUtc,
    sourceLabel: sourceLabels[row.source],
    typeLabel,
    preview,
    fromStatusLabel: fromStatus in syncStatusLabels ? syncStatusLabels[fromStatus as keyof typeof syncStatusLabels] : fromStatus,
    toStatusLabel: toStatus in syncStatusLabels ? syncStatusLabels[toStatus as keyof typeof syncStatusLabels] : toStatus,
  };
}

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

export function InsightsClient() {
  const repo = useMemo(() => getRepository(), []);
  const now = useMemo(() => new Date().toISOString(), []);
  const [openAiPeriod, setOpenAiPeriod] = useState<OpenAiPeriod>("day");
  const [openAiFromLocal, setOpenAiFromLocal] = useState(() => toLocalInputValue(now));
  const [openAiToLocal, setOpenAiToLocal] = useState(() => toLocalInputValue(now));
  const [historyFromLocal, setHistoryFromLocal] = useState("");
  const [historyToLocal, setHistoryToLocal] = useState(() => toLocalInputValue(now));

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
        limit: 60,
      }),
  });

  const historyQuery = useQuery({
    queryKey: ["analysis-history"],
    queryFn: () => repo.listHistory(),
  });

  const historyRows = useMemo(() => {
    const fromUtc = historyFromLocal ? toUtcIso(historyFromLocal) : undefined;
    const toUtc = historyToLocal ? toUtcIso(historyToLocal) : undefined;
    return (historyQuery.data ?? [])
      .filter((row) => withinRange(row.createdAtUtc, fromUtc, toUtc))
      .map(summarizeHistory);
  }, [historyFromLocal, historyQuery.data, historyToLocal]);

  return (
    <div className="mx-auto grid w-full max-w-7xl gap-4 px-4 py-6 lg:grid-cols-2">
      <section className="space-y-4">
        <div className="flex items-center justify-between rounded-2xl border border-white/40 bg-white/55 p-5">
          <div>
            <p className="text-xs uppercase tracking-widest text-ink/60">分析</p>
            <h1 className="text-xl font-bold">OpenAI API利用</h1>
          </div>
          <Link href="/"><Button variant="ghost">ホームへ戻る</Button></Link>
        </div>

        <div className="rounded-2xl border border-white/40 bg-white/55 p-5">
          <h2 className="text-base font-bold">期間フィルタ</h2>
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
        </div>

        <div className="rounded-2xl border border-white/40 bg-white/55 p-5">
          <h2 className="text-base font-bold">集計</h2>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-xl2 bg-white/65 p-2">
              <p className="text-ink/60">総コスト</p>
              <p className="mt-1 text-sm font-semibold">
                {formatUsd(openAiSummaryQuery.data?.totals.totalCostUsd ?? 0)}
              </p>
            </div>
            <div className="rounded-xl2 bg-white/65 p-2">
              <p className="text-ink/60">リクエスト数</p>
              <p className="mt-1 text-sm font-semibold">{openAiSummaryQuery.data?.totals.requestCount ?? 0}</p>
            </div>
            <div className="rounded-xl2 bg-white/65 p-2">
              <p className="text-ink/60">入力token</p>
              <p className="mt-1 text-sm font-semibold">{openAiSummaryQuery.data?.totals.inputTokens ?? 0}</p>
            </div>
            <div className="rounded-xl2 bg-white/65 p-2">
              <p className="text-ink/60">出力token</p>
              <p className="mt-1 text-sm font-semibold">{openAiSummaryQuery.data?.totals.outputTokens ?? 0}</p>
            </div>
          </div>

          <div className="mt-4">
            <p className="text-xs font-semibold text-ink/80">期間別コスト</p>
            <div className="mt-2 space-y-1">
              {openAiSummaryQuery.data?.buckets.slice(0, 10).map((bucket) => (
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
        </div>
      </section>

      <section className="space-y-4">
        <div className="rounded-2xl border border-white/40 bg-white/55 p-5">
          <h2 className="text-base font-bold">OpenAI APIリクエスト履歴</h2>
          <div className="mt-3 space-y-2">
            {openAiRequestsQuery.data?.slice(0, 12).map((row) => (
              <div key={row.id} className="rounded-lg border border-[#d8d2c7] bg-white/70 px-2 py-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{row.model}</span>
                  <Badge className={row.status === "ok" ? "bg-[#def5e1]" : "bg-[#ffe8e1]"}>{row.status}</Badge>
                </div>
                <p className="mt-1 text-ink/70">{formatLocal(row.requestStartedAtUtc)}</p>
                <p className="mt-1 text-ink/75">{row.operation ?? row.workflow ?? row.endpoint}</p>
                <p className="mt-1 text-ink/75">{formatUsd(row.requestCostUsd)} / {row.totalTokens} tokens</p>
              </div>
            ))}
            {(openAiRequestsQuery.data?.length ?? 0) === 0 ? (
              <p className="text-xs text-ink/65">履歴データがありません。</p>
            ) : null}
          </div>
        </div>

        <div className="rounded-2xl border border-white/40 bg-white/55 p-5">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-bold">解析履歴</h2>
            <Button variant="ghost" onClick={() => historyQuery.refetch()}>再読み込み</Button>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-2">
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
            {historyRows.map((row) => (
              <div key={row.id} className="rounded-lg border border-[#d8d2c7] bg-white/70 px-2 py-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge>{row.sourceLabel}</Badge>
                  <Badge>{row.typeLabel}</Badge>
                  <span className="text-ink/70">{row.fromStatusLabel} → {row.toStatusLabel}</span>
                </div>
                <p className="mt-1 text-ink/70">{formatLocal(row.createdAtUtc)}</p>
                <p className="mt-1 line-clamp-2 text-ink/85">{row.preview}</p>
              </div>
            ))}
            {historyRows.length === 0 ? <p className="text-xs text-ink/65">解析履歴データがありません。</p> : null}
          </div>
        </div>
      </section>
    </div>
  );
}
