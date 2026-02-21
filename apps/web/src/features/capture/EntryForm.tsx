"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { scanPii } from "@/domain/pii";
import type { EntryType } from "@/domain/schemas";
import { getRepository } from "@/infra/repository-singleton";
import { useDebouncedEffect } from "@/shared/hooks/use-debounced-effect";
import { toUtcIso } from "@/shared/utils/time";
import { defaultForm } from "@/features/capture/defaults";

type Props = {
  type: EntryType;
};

function splitLines(value: unknown): string[] {
  return String(value ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function materializePayload(type: EntryType, payload: Record<string, unknown>) {
  if (type === "todo") {
    const dueAtLocal = String(payload.dueAtLocal ?? "").trim();
    return {
      status: String(payload.status ?? "todo"),
      priority: Number(payload.priority ?? 3),
      dueAtUtc: dueAtLocal ? toUtcIso(dueAtLocal) : undefined,
      context: String(payload.context ?? "").trim() || undefined,
      details: String(payload.details ?? ""),
    };
  }

  if (type === "meeting") {
    return {
      context: String(payload.context ?? ""),
      notes: String(payload.notes ?? ""),
      decisions: splitLines(payload.decisions),
      actions: splitLines(payload.actions),
    };
  }

  if (type === "wishlist") {
    const targetRaw = String(payload.targetPrice ?? "").trim();
    return {
      item: String(payload.item ?? ""),
      reason: String(payload.reason ?? "").trim() || undefined,
      priority: Number(payload.priority ?? 3),
      targetPrice: targetRaw ? Number(targetRaw) : undefined,
    };
  }

  if (type === "journal") {
    return {
      mood: Number(payload.mood ?? 3),
      energy: Number(payload.energy ?? 3),
      reflection: String(payload.reflection ?? ""),
    };
  }

  if (type === "learning") {
    return {
      url: String(payload.url ?? "").trim() || undefined,
      summary3Lines: String(payload.summary3Lines ?? "").trim() || undefined,
      takeaway: String(payload.takeaway ?? ""),
    };
  }

  return {
    hypothesis: String(payload.hypothesis ?? "").trim() || undefined,
    question: String(payload.question ?? "").trim() || undefined,
    note: String(payload.note ?? ""),
  };
}

function collectPiiTexts(form: ReturnType<typeof defaultForm>): string[] {
  const texts = [form.title, form.body, form.tags];
  Object.values(form.payload).forEach((v) => {
    if (Array.isArray(v)) {
      texts.push(v.join(" "));
      return;
    }
    texts.push(String(v ?? ""));
  });
  return texts.filter(Boolean);
}

function TypeSpecificFields({
  type,
  payload,
  setPayload,
}: {
  type: EntryType;
  payload: Record<string, unknown>;
  setPayload: (next: Record<string, unknown>) => void;
}) {
  const update = (key: string, value: unknown) => {
    setPayload({ ...payload, [key]: value });
  };

  if (type === "journal") {
    return (
      <div className="grid gap-3">
        <label className="grid gap-1 text-sm">
          <span>気分 (1-5)</span>
          <Input type="number" min={1} max={5} value={String(payload.mood ?? 3)} onChange={(e) => update("mood", Number(e.target.value))} />
        </label>
        <label className="grid gap-1 text-sm">
          <span>エネルギー (1-5)</span>
          <Input type="number" min={1} max={5} value={String(payload.energy ?? 3)} onChange={(e) => update("energy", Number(e.target.value))} />
        </label>
        <label className="grid gap-1 text-sm">
          <span>振り返り *</span>
          <Textarea rows={6} value={String(payload.reflection ?? "")} onChange={(e) => update("reflection", e.target.value)} />
        </label>
      </div>
    );
  }

  if (type === "todo") {
    return (
      <div className="grid gap-3">
        <label className="grid gap-1 text-sm">
          <span>内容 *</span>
          <Textarea rows={4} value={String(payload.details ?? "")} onChange={(e) => update("details", e.target.value)} />
        </label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="grid gap-1 text-sm">
            <span>状態</span>
            <Select value={String(payload.status ?? "todo")} onChange={(e) => update("status", e.target.value)}>
              <option value="todo">todo</option>
              <option value="in_progress">in_progress</option>
              <option value="done">done</option>
            </Select>
          </label>
          <label className="grid gap-1 text-sm">
            <span>優先度 (1-4)</span>
            <Input type="number" min={1} max={4} value={String(payload.priority ?? 3)} onChange={(e) => update("priority", Number(e.target.value))} />
          </label>
          <label className="grid gap-1 text-sm">
            <span>期限</span>
            <Input type="datetime-local" value={String(payload.dueAtLocal ?? "")} onChange={(e) => update("dueAtLocal", e.target.value)} />
          </label>
        </div>
        <label className="grid gap-1 text-sm">
          <span>文脈</span>
          <Input value={String(payload.context ?? "")} onChange={(e) => update("context", e.target.value)} />
        </label>
      </div>
    );
  }

  if (type === "learning") {
    return (
      <div className="grid gap-3">
        <label className="grid gap-1 text-sm">
          <span>URL</span>
          <Input type="url" value={String(payload.url ?? "")} onChange={(e) => update("url", e.target.value)} />
        </label>
        <label className="grid gap-1 text-sm">
          <span>3行要約</span>
          <Textarea rows={4} value={String(payload.summary3Lines ?? "")} onChange={(e) => update("summary3Lines", e.target.value)} />
        </label>
        <label className="grid gap-1 text-sm">
          <span>学び *</span>
          <Textarea rows={4} value={String(payload.takeaway ?? "")} onChange={(e) => update("takeaway", e.target.value)} />
        </label>
      </div>
    );
  }

  if (type === "thought") {
    return (
      <div className="grid gap-3">
        <label className="grid gap-1 text-sm">
          <span>仮説</span>
          <Textarea rows={3} value={String(payload.hypothesis ?? "")} onChange={(e) => update("hypothesis", e.target.value)} />
        </label>
        <label className="grid gap-1 text-sm">
          <span>問い</span>
          <Textarea rows={3} value={String(payload.question ?? "")} onChange={(e) => update("question", e.target.value)} />
        </label>
        <label className="grid gap-1 text-sm">
          <span>メモ *</span>
          <Textarea rows={6} value={String(payload.note ?? "")} onChange={(e) => update("note", e.target.value)} />
        </label>
      </div>
    );
  }

  if (type === "meeting") {
    return (
      <div className="grid gap-3">
        <label className="grid gap-1 text-sm">
          <span>Context *</span>
          <Textarea rows={3} value={String(payload.context ?? "")} onChange={(e) => update("context", e.target.value)} />
        </label>
        <label className="grid gap-1 text-sm">
          <span>Notes *</span>
          <Textarea rows={6} value={String(payload.notes ?? "")} onChange={(e) => update("notes", e.target.value)} />
        </label>
        <label className="grid gap-1 text-sm">
          <span>Decisions (1行1項目)</span>
          <Textarea rows={4} value={String(payload.decisions ?? "")} onChange={(e) => update("decisions", e.target.value)} />
        </label>
        <label className="grid gap-1 text-sm">
          <span>Actions (1行1項目)</span>
          <Textarea rows={4} value={String(payload.actions ?? "")} onChange={(e) => update("actions", e.target.value)} />
        </label>
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      <label className="grid gap-1 text-sm">
        <span>アイテム *</span>
        <Input value={String(payload.item ?? "")} onChange={(e) => update("item", e.target.value)} />
      </label>
      <label className="grid gap-1 text-sm">
        <span>理由</span>
        <Textarea rows={3} value={String(payload.reason ?? "")} onChange={(e) => update("reason", e.target.value)} />
      </label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm">
          <span>優先度 (1-5)</span>
          <Input type="number" min={1} max={5} value={String(payload.priority ?? 3)} onChange={(e) => update("priority", Number(e.target.value))} />
        </label>
        <label className="grid gap-1 text-sm">
          <span>目標価格</span>
          <Input type="number" min={0} value={String(payload.targetPrice ?? "")} onChange={(e) => update("targetPrice", e.target.value)} />
        </label>
      </div>
    </div>
  );
}

const pageTitle: Record<EntryType, string> = {
  journal: "Journal",
  todo: "Todo",
  learning: "Learning",
  thought: "Thought",
  meeting: "Meeting",
  wishlist: "Wishlist",
};

export function EntryForm({ type }: Props) {
  const router = useRouter();
  const repo = useMemo(() => getRepository(), []);

  const [form, setForm] = useState(() => defaultForm(type));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mediumRiskOpen, setMediumRiskOpen] = useState(false);
  const [pendingSubmit, setPendingSubmit] = useState<null | (() => Promise<void>)>(null);

  useEffect(() => {
    let mounted = true;
    repo
      .loadDraft(type)
      .then((draft) => {
        if (!mounted || !draft) return;
        setForm((prev) => ({ ...prev, ...(draft.value as Record<string, unknown>) }));
      })
      .catch(() => {
        // ignore draft load errors in UI v1
      })
      .finally(() => mounted && setLoading(false));

    return () => {
      mounted = false;
    };
  }, [repo, type]);

  useDebouncedEffect(
    () => {
      if (loading) return;
      void repo.saveDraft(type, form);
    },
    [form, loading, repo, type],
    600,
  );

  const setPayload = (payload: Record<string, unknown>) => {
    setForm((prev) => ({ ...prev, payload }));
  };

  const runSubmit = async () => {
    const payload = materializePayload(type, form.payload);
    await repo.createEntry({
      declaredType: type,
      title: form.title.trim() || undefined,
      body: form.body.trim() || undefined,
      tags: form.tags
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
      occurredAtUtc: toUtcIso(form.occurredAtLocal),
      sensitivity: form.sensitivity,
      payload,
    });

    await repo.saveDraft(type, defaultForm(type));
    setNotice("保存しました");
    setError(null);
    setForm(defaultForm(type));
    setTimeout(() => {
      router.push("/");
      router.refresh();
    }, 200);
  };

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const pii = scanPii(collectPiiTexts(form));
      if (pii.risk === "high") {
        setError("高リスクの機密情報が含まれるため保存を中止しました。");
        return;
      }

      if (pii.risk === "medium") {
        setPendingSubmit(() => runSubmit);
        setMediumRiskOpen(true);
        return;
      }

      await runSubmit();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました");
    }
  };

  return (
    <div className="mx-auto grid w-full max-w-4xl gap-5 px-4 py-6">
      <Card className="p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-widest text-ink/60">Capture</p>
            <h1 className="mt-1 text-2xl font-bold text-ink">{pageTitle[type]}</h1>
          </div>
          <Button variant="ghost" onClick={() => router.push("/")}>ダッシュボードへ</Button>
        </div>
      </Card>

      <Card className="p-6">
        <form className="grid gap-4" onSubmit={onSubmit}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-sm">
              <span>タイトル</span>
              <Input value={form.title} onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))} />
            </label>
            <label className="grid gap-1 text-sm">
              <span>発生時刻</span>
              <Input
                type="datetime-local"
                value={form.occurredAtLocal}
                onChange={(e) => setForm((prev) => ({ ...prev, occurredAtLocal: e.target.value }))}
              />
            </label>
          </div>

          <label className="grid gap-1 text-sm">
            <span>共通メモ</span>
            <Textarea rows={3} value={form.body} onChange={(e) => setForm((prev) => ({ ...prev, body: e.target.value }))} />
          </label>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-sm">
              <span>タグ (カンマ区切り)</span>
              <Input value={form.tags} onChange={(e) => setForm((prev) => ({ ...prev, tags: e.target.value }))} />
            </label>
            <label className="grid gap-1 text-sm">
              <span>Sensitivity</span>
              <Select
                value={form.sensitivity}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, sensitivity: e.target.value as typeof prev.sensitivity }))
                }
              >
                <option value="public">public</option>
                <option value="internal">internal</option>
                <option value="sensitive">sensitive</option>
              </Select>
            </label>
          </div>

          <TypeSpecificFields type={type} payload={form.payload} setPayload={setPayload} />

          {error ? <p className="rounded-xl2 bg-[#ffe8e1] px-3 py-2 text-sm text-[#9a3317]">{error}</p> : null}
          {notice ? <p className="rounded-xl2 bg-[#def5e1] px-3 py-2 text-sm text-[#1f5d2d]">{notice}</p> : null}

          <div className="flex items-center gap-2">
            <Button type="submit">保存</Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setForm(defaultForm(type));
                setError(null);
              }}
            >
              リセット
            </Button>
          </div>
        </form>
      </Card>

      <Dialog
        open={mediumRiskOpen}
        title="注意: 個人情報の可能性があります"
        onCancel={() => {
          setMediumRiskOpen(false);
          setPendingSubmit(null);
        }}
        onConfirm={() => {
          setMediumRiskOpen(false);
          const run = pendingSubmit;
          setPendingSubmit(null);
          if (run) {
            void run().catch((err) => {
              setError(err instanceof Error ? err.message : "保存に失敗しました");
            });
          }
        }}
      >
        メールアドレスや連絡先らしき情報が含まれている可能性があります。保存を続行しますか。
      </Dialog>
    </div>
  );
}
