"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getRepository } from "@/infra/repository-singleton";
import { useSessionStore } from "@/shared/state/session-store";

export function LockScreen() {
  const router = useRouter();
  const repo = useMemo(() => getRepository(), []);
  const { setLockState } = useSessionStore();

  const [pin, setPin] = useState("");
  const [hasPin, setHasPin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    repo
      .hasPin()
      .then(setHasPin)
      .finally(() => setLoading(false));
  }, [repo]);

  const onSetup = async () => {
    try {
      await repo.lockWithPin(pin);
      setHasPin(true);
      setError(null);
      setLockState(true);
      setPin("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "PIN設定に失敗しました");
    }
  };

  const onUnlock = async () => {
    const ok = await repo.unlockWithPin(pin);
    if (!ok) {
      setError("PINが一致しません");
      return;
    }
    await repo.setLocked(false);
    setLockState(false);
    setError(null);
    setPin("");
    router.replace("/");
  };

  if (loading) {
    return <div className="p-8 text-sm text-ink/70">読み込み中...</div>;
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-xl items-center px-4 py-8">
      <Card className="w-full p-6">
        <p className="text-xs uppercase tracking-widest text-ink/60">セキュリティ</p>
        <h1 className="mt-1 text-2xl font-bold">ローカルPINロック</h1>
        <p className="mt-2 text-sm text-ink/70">
          {hasPin ? "PINで解除してください。" : "最初にPINを設定します。"}
        </p>

        <div className="mt-4 grid gap-2">
          <label className="text-sm">PIN</label>
          <Input
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            type="password"
            inputMode="numeric"
            placeholder="4桁以上"
          />
        </div>

        {error ? <p className="mt-3 rounded-xl2 bg-[#ffe8e1] px-3 py-2 text-sm text-[#9a3317]">{error}</p> : null}

        <div className="mt-4 flex gap-2">
          {hasPin ? (
            <Button onClick={onUnlock}>ロック解除</Button>
          ) : (
            <Button onClick={onSetup}>PINを設定</Button>
          )}
        </div>
      </Card>
    </div>
  );
}
