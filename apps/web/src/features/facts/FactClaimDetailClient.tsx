"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getRepository } from "@/infra/repository-singleton";

type Props = {
  claimId: string;
};

export function FactClaimDetailClient({ claimId }: Props) {
  const repo = useMemo(() => getRepository(), []);
  const [editing, setEditing] = useState(false);
  const [canonical, setCanonical] = useState("");
  const [revisionNote, setRevisionNote] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const claimQuery = useQuery({
    queryKey: ["fact-claim", claimId],
    queryFn: () => repo.getFactClaimById(claimId),
  });

  async function reviseClaim() {
    if (!canonical.trim()) {
      setNotice("改訂後テキストを入力してください。");
      return;
    }
    try {
      const revised = await repo.reviseFactClaim(claimId, {
        objectTextCanonical: canonical.trim(),
        revisionNote: revisionNote.trim() || undefined,
      });
      setNotice(`改訂を保存しました: ${revised.id}`);
      setEditing(false);
      setCanonical("");
      setRevisionNote("");
      await claimQuery.refetch();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "改訂に失敗しました");
    }
  }

  async function retractClaim() {
    try {
      const retracted = await repo.retractFactClaim(claimId, {
        reason: "ユーザー手動で取り下げ",
      });
      setNotice(`claimを取り下げました: ${retracted.status}`);
      await claimQuery.refetch();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "取り下げに失敗しました");
    }
  }

  const claim = claimQuery.data;

  return (
    <div className="mx-auto max-w-4xl space-y-4 px-4 py-6">
      <div className="flex items-center justify-between rounded-2xl border border-white/40 bg-white/55 p-5">
        <div>
          <p className="text-xs uppercase tracking-widest text-ink/60">Fact Claim</p>
          <h1 className="text-xl font-bold">Claim詳細</h1>
        </div>
        <Link href="/facts"><Button variant="ghost">一覧へ戻る</Button></Link>
      </div>

      {claim ? (
        <div className="space-y-3 rounded-2xl border border-white/40 bg-white/55 p-5">
          <div className="flex flex-wrap gap-2">
            <Badge>{claim.status}</Badge>
            <Badge>{claim.modality}</Badge>
            <Badge>{claim.meRole}</Badge>
            <Badge>確信度 {Math.round(claim.certainty * 100)}%</Badge>
          </div>

          <p className="text-sm text-ink/75">{claim.subjectText} / {claim.predicate}</p>
          <p className="rounded-lg bg-white/80 px-3 py-2 text-sm text-ink/90">{claim.objectTextCanonical}</p>
          <p className="rounded-lg bg-[#f8f4ec] px-3 py-2 text-xs text-ink/70">raw: {claim.objectTextRaw}</p>

          <div>
            <p className="text-xs font-semibold text-ink/80">根拠</p>
            <div className="mt-1 space-y-1">
              {claim.evidenceSpans.map((span) => (
                <p key={span.id} className="rounded bg-white/85 px-2 py-1 text-xs text-ink/80">
                  {span.excerpt}
                </p>
              ))}
            </div>
          </div>

          <div>
            <p className="text-xs font-semibold text-ink/80">軸</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {claim.dimensions.map((d) => (
                <Badge key={d.id}>{d.dimensionType}:{d.dimensionValue}</Badge>
              ))}
              {claim.dimensions.length === 0 ? <p className="text-xs text-ink/65">軸なし</p> : null}
            </div>
          </div>

          <div className="flex flex-wrap gap-2 border-t border-[#e5ddcf] pt-3">
            <Button variant="ghost" onClick={() => setEditing((v) => !v)}>
              {editing ? "改訂を閉じる" : "手動改訂"}
            </Button>
            <Button variant="ghost" onClick={retractClaim}>取り下げ</Button>
          </div>

          {editing ? (
            <div className="space-y-2 rounded-xl2 border border-[#d9d1c4] bg-white/80 p-3">
              <label className="grid gap-1 text-xs">
                <span>改訂後 canonical text</span>
                <textarea
                  rows={3}
                  value={canonical}
                  onChange={(e) => setCanonical(e.target.value)}
                  className="rounded-xl2 border border-[#d8d2c7] bg-white px-3 py-2 text-sm"
                />
              </label>
              <label className="grid gap-1 text-xs">
                <span>改訂メモ</span>
                <input
                  value={revisionNote}
                  onChange={(e) => setRevisionNote(e.target.value)}
                  className="rounded-xl2 border border-[#d8d2c7] bg-white px-3 py-2 text-sm"
                />
              </label>
              <Button onClick={reviseClaim}>改訂を保存</Button>
            </div>
          ) : null}

          {notice ? <p className="text-sm text-ink/75">{notice}</p> : null}

          <details>
            <summary className="cursor-pointer text-xs text-ink/65">構造(JSON)</summary>
            <pre className="mt-1 overflow-x-auto rounded bg-[#f7f3ea] p-2 text-[10px] text-ink/80">
              {JSON.stringify(claim, null, 2)}
            </pre>
          </details>
        </div>
      ) : (
        <div className="rounded-2xl border border-white/40 bg-white/55 p-5 text-sm text-ink/70">claimが見つかりません。</div>
      )}
    </div>
  );
}
