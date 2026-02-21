import { v7 as uuidv7 } from "uuid";
import type { Entry, ListQuery, SearchResult } from "./schemas.js";

export function newId(): string {
  return uuidv7();
}

export function nowUtcIso(): string {
  return new Date().toISOString();
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^0-9a-z\u3040-\u30ff\u4e00-\u9faf\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

export function buildSearchableText(entry: Entry): string {
  const fields: string[] = [entry.title ?? "", entry.body ?? "", entry.tags.join(" ")];
  for (const value of Object.values(entry.payload as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      fields.push(value.join(" "));
      continue;
    }
    if (typeof value === "string" || typeof value === "number") {
      fields.push(String(value));
    }
  }
  return fields.join(" ").trim();
}

export function filterEntries(entries: Entry[], query?: ListQuery): Entry[] {
  if (!query) {
    return [...entries].sort((a, b) => b.occurredAtUtc.localeCompare(a.occurredAtUtc));
  }

  let out = [...entries];
  if (query.types?.length) {
    out = out.filter((e) => query.types?.includes(e.declaredType));
  }
  if (query.fromUtc) {
    out = out.filter((e) => e.occurredAtUtc >= query.fromUtc!);
  }
  if (query.toUtc) {
    out = out.filter((e) => e.occurredAtUtc <= query.toUtc!);
  }
  if (query.tags?.length) {
    out = out.filter((e) => query.tags!.every((tag) => e.tags.includes(tag)));
  }
  if (query.sensitivity) {
    out = out.filter((e) => e.sensitivity === query.sensitivity);
  }
  out.sort((a, b) => b.occurredAtUtc.localeCompare(a.occurredAtUtc));
  if (query.limit) {
    out = out.slice(0, query.limit);
  }
  return out;
}

export function searchScore(haystack: string, query: string, occurredAtUtc: string): number {
  const lower = haystack.toLowerCase();
  const q = query.toLowerCase();
  let base = 0;

  if (lower.includes(` ${q} `) || lower === q) {
    base += 3;
  } else if (lower.split(/\s+/).some((token) => token.startsWith(q))) {
    base += 2;
  } else if (lower.includes(q)) {
    base += 1;
  }

  const ageHours = Math.max((Date.now() - new Date(occurredAtUtc).getTime()) / (1000 * 60 * 60), 1);
  const recencyBoost = 1 / Math.log2(ageHours + 2);
  return base + recencyBoost;
}

export function searchEntries(entries: Entry[], text: string): SearchResult[] {
  const q = text.toLowerCase();
  return entries
    .map((entry) => {
      const searchable = buildSearchableText(entry);
      const score = searchScore(searchable, text, entry.occurredAtUtc);
      if (score < 1) {
        return null;
      }
      const matchedFields: string[] = [];
      if ((entry.title ?? "").toLowerCase().includes(q)) {
        matchedFields.push("title");
      }
      if ((entry.body ?? "").toLowerCase().includes(q)) {
        matchedFields.push("body");
      }
      if (entry.tags.some((tag) => tag.toLowerCase().includes(q))) {
        matchedFields.push("tags");
      }
      if (matchedFields.length === 0) {
        matchedFields.push("payload");
      }
      return { entry, score, matchedFields };
    })
    .filter((v): v is SearchResult => Boolean(v))
    .sort((a, b) => b.score - a.score);
}

export function toIso(value: unknown): string {
  if (typeof value === "string") {
    return new Date(value).toISOString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return new Date(String(value)).toISOString();
}
