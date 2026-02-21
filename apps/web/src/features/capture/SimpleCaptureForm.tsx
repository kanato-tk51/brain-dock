"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { scanPii } from "@/domain/pii";
import { entryTypes, type EntryType } from "@/domain/schemas";
import { getRepository } from "@/infra/repository-singleton";
import { useDebouncedEffect } from "@/shared/hooks/use-debounced-effect";

const labels: Record<EntryType, string> = {
  journal: "日記",
  todo: "TODO",
  learning: "学び",
  thought: "思考",
  meeting: "会議",
};

type Props = {
  initialType: EntryType;
  embedded?: boolean;
  onSaved?: () => void | Promise<void>;
};

export function SimpleCaptureForm({ initialType, embedded = false, onSaved }: Props) {
  const repo = useMemo(() => getRepository(), []);

  const [selectedType, setSelectedType] = useState<EntryType>(initialType);
  const [text, setText] = useState("");
  const [loadingDraft, setLoadingDraft] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mediumRiskOpen, setMediumRiskOpen] = useState(false);
  const [pendingSubmit, setPendingSubmit] = useState<null | (() => Promise<void>)>(null);

  useEffect(() => {
    let mounted = true;
    setLoadingDraft(true);
    repo
      .loadDraft(selectedType)
      .then((draft) => {
        if (!mounted) return;
        const value = draft?.value as { text?: unknown } | undefined;
        setText(typeof value?.text === "string" ? value.text : "");
      })
      .catch(() => {
        if (mounted) {
          setText("");
        }
      })
      .finally(() => {
        if (mounted) {
          setLoadingDraft(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [repo, selectedType]);

  useDebouncedEffect(
    () => {
      if (loadingDraft) return;
      void repo.saveDraft(selectedType, { text });
    },
    [loadingDraft, repo, selectedType, text],
    500,
  );

  const runSubmit = async () => {
    const normalized = text.trim();
    if (!normalized) {
      setError("入力内容は必須です");
      return;
    }

    await repo.captureText({
      declaredType: selectedType,
      text: normalized,
    });

    await repo.saveDraft(selectedType, { text: "" });
    setText("");
    setError(null);
    setNotice("保存しました");
    if (onSaved) {
      await onSaved();
    }
  };

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const pii = scanPii([text]);
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

  const formContent = (
    <Card className={embedded ? "p-5" : "p-6"}>
      {!embedded ? (
        <div className="mb-4">
          <p className="text-xs uppercase tracking-widest text-ink/60">Capture</p>
          <h1 className="mt-1 text-2xl font-bold text-ink">単一入力</h1>
        </div>
      ) : (
        <h2 className="text-base font-bold">新規入力</h2>
      )}

      <form className="mt-3 grid gap-4" onSubmit={onSubmit}>
        <label className="grid gap-1 text-sm">
          <span>入力タイプ</span>
          <Select
            value={selectedType}
            onChange={(e) => {
              const next = e.target.value as EntryType;
              setSelectedType(next);
              setError(null);
              setNotice(null);
            }}
          >
            {entryTypes.map((type) => (
              <option key={type} value={type}>{labels[type]}</option>
            ))}
          </Select>
        </label>

        <label className="grid gap-1 text-sm">
          <span>入力内容</span>
          <Textarea
            rows={embedded ? 6 : 10}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
              setNotice(null);
            }}
            placeholder="ここに自由入力してください"
          />
        </label>

        {error ? <p className="rounded-xl2 bg-[#ffe8e1] px-3 py-2 text-sm text-[#9a3317]">{error}</p> : null}
        {notice ? <p className="rounded-xl2 bg-[#def5e1] px-3 py-2 text-sm text-[#1f5d2d]">{notice}</p> : null}

        <div className="flex items-center">
          <Button type="submit">保存</Button>
        </div>
      </form>
    </Card>
  );

  return (
    <>
      {embedded ? <div>{formContent}</div> : <div className="mx-auto grid w-full max-w-3xl gap-5 px-4 py-6">{formContent}</div>}
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
    </>
  );
}
