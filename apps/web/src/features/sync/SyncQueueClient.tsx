"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getRepository } from "@/infra/repository-singleton";
import { newUuidV7 } from "@/shared/utils/uuid";
import { formatLocal } from "@/shared/utils/time";

export function SyncQueueClient() {
  const repo = useMemo(() => getRepository(), []);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const queueQuery = useQuery({
    queryKey: ["sync-queue"],
    queryFn: () => repo.listSyncQueue(),
  });

  const historyQuery = useQuery({
    queryKey: ["sync-history"],
    queryFn: () => repo.listHistory(),
  });

  const runSync = async () => {
    setRunning(true);
    setMessage(null);
    try {
      const queue = await repo.listSyncQueue();
      const pending = queue.filter((q) => q.status === "pending");
      for (const item of pending) {
        await repo.markSynced(item.id, `remote-${newUuidV7()}`);
      }
      setMessage(`${pending.length}件を同期しました`);
      await queueQuery.refetch();
      await historyQuery.refetch();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "同期に失敗しました");
    } finally {
      setRunning(false);
    }
  };

  const queue = queueQuery.data ?? [];
  const history = historyQuery.data ?? [];

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-4 px-4 py-6 lg:grid-cols-2">
      <Card className="p-5">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-widest text-ink/60">Sync</p>
            <h1 className="text-xl font-bold">Manual Sync Queue</h1>
          </div>
          <Link href="/"><Button variant="ghost">戻る</Button></Link>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <Button onClick={runSync} disabled={running}>{running ? "同期中..." : "未送信を同期"}</Button>
          <Badge>pending: {queue.filter((q) => q.status === "pending").length}</Badge>
        </div>

        {message ? <p className="mt-3 rounded-xl2 bg-white/60 px-3 py-2 text-sm">{message}</p> : null}

        <div className="mt-4 space-y-2">
          {queue.map((item) => (
            <Card key={item.id} className="bg-white/70 p-3">
              <p className="text-xs text-ink/60">entry: {item.entryId}</p>
              <div className="mt-1 flex items-center justify-between">
                <Badge>{item.status}</Badge>
                <p className="text-xs text-ink/60">{formatLocal(item.createdAtUtc)}</p>
              </div>
            </Card>
          ))}
          {queue.length === 0 ? <p className="text-sm text-ink/70">キューは空です。</p> : null}
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="text-lg font-bold">LWW History</h2>
        <p className="text-sm text-ink/60">before/afterの差分ログ（source local/remote）</p>
        <div className="mt-3 space-y-2">
          {history.map((h) => (
            <Card key={h.id} className="bg-white/70 p-3">
              <div className="flex items-center justify-between gap-2">
                <Badge>{h.source}</Badge>
                <p className="text-xs text-ink/60">{formatLocal(h.createdAtUtc)}</p>
              </div>
              <p className="mt-2 break-all font-mono text-xs text-ink/70">entry: {h.entryId}</p>
            </Card>
          ))}
          {history.length === 0 ? <p className="text-sm text-ink/70">履歴はまだありません。</p> : null}
        </div>
      </Card>
    </div>
  );
}
