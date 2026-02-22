"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { DimensionType, FactModality, MeRole, RollupPeriodType } from "@/domain/schemas";
import { getRepository } from "@/infra/repository-singleton";
import { formatLocal } from "@/shared/utils/time";

const modalityLabels: Record<FactModality, string> = {
  fact: "事実",
  plan: "予定",
  hypothesis: "仮説",
  request: "要望",
  feeling: "感情",
};

const meRoleLabels: Record<MeRole, string> = {
  actor: "行動者",
  experiencer: "体験者",
  observer: "観察者",
  recipient: "受け手",
  none: "未分類",
};

const dimensionLabels: Record<DimensionType, string> = {
  person: "人物",
  place: "場所",
  activity: "行動",
  emotion: "感情",
  health: "健康",
  topic: "話題",
  project: "プロジェクト",
  item: "アイテム",
  reason: "理由",
  time_hint: "時間ヒント",
};

export function FactsClient() {
  const repo = useMemo(() => getRepository(), []);
  const [text, setText] = useState("");
  const [modality, setModality] = useState<FactModality | "">("");
  const [meRole, setMeRole] = useState<MeRole | "">("");
  const [dimensionType, setDimensionType] = useState<DimensionType | "">("");
  const [dimensionValue, setDimensionValue] = useState("");
  const [rebuilding, setRebuilding] = useState(false);
  const [rollupPeriod] = useState<RollupPeriodType>("weekly");
  const [notice, setNotice] = useState<string | null>(null);

  const factsQuery = useQuery({
    queryKey: ["facts-claims", text, modality, meRole, dimensionType, dimensionValue],
    queryFn: () =>
      repo.searchFacts({
        text: text.trim() || undefined,
        modality: modality || undefined,
        meRole: meRole || undefined,
        dimensionType: dimensionType || undefined,
        dimensionValue: dimensionValue.trim() || undefined,
        limit: 200,
      }),
  });

  const rollupsQuery = useQuery({
    queryKey: ["facts-rollups"],
    queryFn: () =>
      repo.listRollups({
        scopeType: "all",
        periodType: "weekly",
        limit: 20,
      }),
  });

  async function rebuildRollups() {
    const to = new Date();
    const from = new Date(to);
    from.setMonth(from.getMonth() - 1);
    setRebuilding(true);
    setNotice(null);
    try {
      const rows = await repo.rebuildRollups({
        scopeType: "all",
        scopeKey: "all",
        periodType: rollupPeriod,
        fromUtc: from.toISOString(),
        toUtc: to.toISOString(),
      });
      setNotice(`ロールアップを更新しました (${rows.length}件)`);
      await rollupsQuery.refetch();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "ロールアップ更新に失敗しました");
    } finally {
      setRebuilding(false);
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-4 px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-white/40 bg-white/55 p-5">
        <div>
          <p className="text-xs uppercase tracking-widest text-ink/60">Facts</p>
          <h1 className="text-xl font-bold">ファクト探索</h1>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/"><Button variant="ghost">ホームへ戻る</Button></Link>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
        <section className="rounded-2xl border border-white/40 bg-white/55 p-4">
          <h2 className="text-sm font-semibold">検索フィルタ</h2>
          <div className="mt-2 space-y-2">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="キーワード"
              className="w-full rounded-xl2 border border-[#d8d2c7] bg-white/80 px-3 py-2 text-sm"
            />

            <select
              value={modality}
              onChange={(e) => setModality(e.target.value as FactModality | "")}
              className="w-full rounded-xl2 border border-[#d8d2c7] bg-white/80 px-3 py-2 text-sm"
            >
              <option value="">解釈（すべて）</option>
              {Object.keys(modalityLabels).map((key) => (
                <option key={key} value={key}>{modalityLabels[key as FactModality]}</option>
              ))}
            </select>

            <select
              value={meRole}
              onChange={(e) => setMeRole(e.target.value as MeRole | "")}
              className="w-full rounded-xl2 border border-[#d8d2c7] bg-white/80 px-3 py-2 text-sm"
            >
              <option value="">me役割（すべて）</option>
              {Object.keys(meRoleLabels).map((key) => (
                <option key={key} value={key}>{meRoleLabels[key as MeRole]}</option>
              ))}
            </select>

            <select
              value={dimensionType}
              onChange={(e) => setDimensionType(e.target.value as DimensionType | "")}
              className="w-full rounded-xl2 border border-[#d8d2c7] bg-white/80 px-3 py-2 text-sm"
            >
              <option value="">軸タイプ（すべて）</option>
              {Object.keys(dimensionLabels).map((key) => (
                <option key={key} value={key}>{dimensionLabels[key as DimensionType]}</option>
              ))}
            </select>

            <input
              value={dimensionValue}
              onChange={(e) => setDimensionValue(e.target.value)}
              placeholder="軸値 (例: お台場, 喉)"
              className="w-full rounded-xl2 border border-[#d8d2c7] bg-white/80 px-3 py-2 text-sm"
            />
          </div>

          <div className="mt-4 border-t border-[#e6ddcf] pt-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">圧縮サマリ</h3>
              <Button variant="ghost" onClick={rebuildRollups} disabled={rebuilding}>
                {rebuilding ? "更新中..." : "再生成"}
              </Button>
            </div>
            {notice ? <p className="mt-2 text-xs text-ink/70">{notice}</p> : null}
            <div className="mt-2 space-y-2">
              {(rollupsQuery.data ?? []).slice(0, 5).map((rollup) => (
                <div key={rollup.id} className="rounded-lg border border-[#ddd5c8] bg-white/70 px-2 py-2">
                  <p className="text-[11px] text-ink/65">{formatLocal(rollup.periodStartUtc)} - {formatLocal(rollup.periodEndUtc)}</p>
                  <p className="mt-1 line-clamp-3 text-xs text-ink/85">{rollup.summaryText}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-white/40 bg-white/55 p-4">
          <h2 className="text-base font-bold">Claim一覧</h2>
          <div className="mt-3 space-y-2">
            {(factsQuery.data ?? []).map((claim) => (
              <Link
                key={claim.id}
                href={`/facts/${claim.id}`}
                className="block rounded-lg border border-[#ddd5c8] bg-white/70 px-3 py-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge>{modalityLabels[claim.modality]}</Badge>
                  <Badge>{meRoleLabels[claim.meRole]}</Badge>
                  <span className="text-[11px] text-ink/70">確信度 {Math.round(claim.certainty * 100)}%</span>
                </div>
                <p className="mt-2 text-sm font-medium text-ink/90">
                  {claim.subjectText} / {claim.predicate} / {claim.objectTextCanonical}
                </p>
                {claim.dimensions.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {claim.dimensions.slice(0, 6).map((dimension) => (
                      <Badge key={dimension.id}>
                        {dimensionLabels[dimension.dimensionType]}:{dimension.dimensionValue}
                      </Badge>
                    ))}
                  </div>
                ) : null}
              </Link>
            ))}
            {(factsQuery.data?.length ?? 0) === 0 ? <p className="text-sm text-ink/70">該当するclaimがありません。</p> : null}
          </div>
        </section>
      </div>
    </div>
  );
}
