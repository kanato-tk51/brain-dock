"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { EntryType } from "@/domain/schemas";
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

export function DashboardClient() {
  const repo = useMemo(() => getRepository(), []);
  const { searchText, filters, setSearchText, toggleType, setDateRange, setTags, clearFilters } =
    useUiStore();
  const [fromLocal, setFromLocal] = useState(filters.fromUtc ? toLocalInputValue(filters.fromUtc) : "");
  const [toLocal, setToLocal] = useState(filters.toUtc ? toLocalInputValue(filters.toUtc) : "");
  const [tagsInput, setTagsInput] = useState(filters.tags.join(","));

  useEffect(() => {
    setFromLocal(filters.fromUtc ? toLocalInputValue(filters.fromUtc) : "");
    setToLocal(filters.toUtc ? toLocalInputValue(filters.toUtc) : "");
    setTagsInput(filters.tags.join(","));
  }, [filters.fromUtc, filters.toUtc, filters.tags]);

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

  const stats = useMemo(() => {
    const list = entriesQuery.data ?? [];
    const today = new Date().toISOString().slice(0, 10);
    const todayCount = list.filter((e) => e.occurredAtUtc.startsWith(today)).length;
    const pendingSync = list.filter((e) => e.syncStatus === "pending").length;
    const byType = Object.fromEntries(entryTypes.map((t) => [t, list.filter((e) => e.declaredType === t).length])) as Record<
      EntryType,
      number
    >;
    return { todayCount, pendingSync, byType };
  }, [entriesQuery.data]);

  return (
    <div className="mx-auto grid w-full max-w-7xl gap-4 px-4 py-5 lg:grid-cols-[1fr_320px]">
      <div className="space-y-4">
        <Card className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold">Timeline Dashboard</h1>
            </div>
            <Link href="/sync"><Button variant="ghost">Sync Queue</Button></Link>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Card className="bg-white/65 p-3">
              <p className="text-xs text-ink/60">今日の記録</p>
              <p className="text-2xl font-bold">{stats.todayCount}</p>
            </Card>
            <Card className="bg-white/65 p-3">
              <p className="text-xs text-ink/60">未Sync</p>
              <p className="text-2xl font-bold">{stats.pendingSync}</p>
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
            <h2 className="text-lg font-bold">Timeline</h2>
            <Button variant="ghost" onClick={clearFilters}>Filterクリア</Button>
          </div>

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
                    <p className="text-xs text-ink/60">{labels[entry.declaredType]} / {formatLocal(entry.occurredAtUtc)}</p>
                    <h3 className="mt-1 text-sm font-semibold">{entry.title || "(無題)"}</h3>
                    <p className="mt-1 text-sm text-ink/85 line-clamp-3">{entry.body || JSON.stringify(entry.payload)}</p>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {entry.tags.map((tag) => <Badge key={tag}>#{tag}</Badge>)}
                    </div>
                  </div>
                  <Badge className={entry.syncStatus === "pending" ? "bg-[#fff2d9]" : "bg-[#def5e1]"}>{entry.syncStatus}</Badge>
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
          <p className="mt-2 text-xs text-ink/60">{"exact > prefix > contains + recency boost"}</p>
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
          <h3 className="text-sm font-semibold">Date range</h3>
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

          <h3 className="mt-4 text-sm font-semibold">Tags filter</h3>
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
            placeholder="example: work,weekly"
            className="mt-2 w-full rounded-xl2 border border-[#d8d2c7] bg-white/80 px-3 py-2 text-sm"
          />
        </Card>
      </div>
    </div>
  );
}
