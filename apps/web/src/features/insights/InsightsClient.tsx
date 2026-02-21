"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { OpenAiPeriod } from "@/domain/schemas";
import { getRepository } from "@/infra/repository-singleton";
import { formatLocal, toLocalInputValue, toUtcIso } from "@/shared/utils/time";

const openAiPeriodLabels: Record<OpenAiPeriod, string> = {
  day: "日",
  week: "週",
  month: "月",
};

function formatUsd(value: number): string {
  return `$${value.toFixed(6)}`;
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

export function InsightsClient() {
  const repo = useMemo(() => getRepository(), []);
  const { fromLocal, toLocal } = useMemo(() => defaultDateRange(), []);
  const [openAiPeriod, setOpenAiPeriod] = useState<OpenAiPeriod>("day");
  const [openAiFromLocal, setOpenAiFromLocal] = useState(fromLocal);
  const [openAiToLocal, setOpenAiToLocal] = useState(toLocal);

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

  return (
    <div className="mx-auto max-w-7xl space-y-4 px-4 py-6">
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-white/40 bg-white/55 p-5">
          <div>
            <p className="text-xs uppercase tracking-widest text-ink/60">分析</p>
            <h1 className="text-xl font-bold">OpenAI API利用</h1>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/analysis-history"><Button variant="ghost">解析履歴へ</Button></Link>
            <Link href="/"><Button variant="ghost">ホームへ戻る</Button></Link>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
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
                <p className="mt-1 text-sm font-semibold">{formatUsd(openAiSummaryQuery.data?.totals.totalCostUsd ?? 0)}</p>
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
        </div>

        <div className="rounded-2xl border border-white/40 bg-white/55 p-5">
          <h2 className="text-base font-bold">OpenAI APIリクエスト履歴</h2>
          <div className="mt-3 space-y-2">
            {openAiRequestsQuery.data?.slice(0, 20).map((row) => (
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
      </section>
    </div>
  );
}
