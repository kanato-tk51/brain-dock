export function nowUtcIso(): string {
  return new Date().toISOString();
}

export function toUtcIso(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid datetime: ${value}`);
  }
  return date.toISOString();
}

export function toLocalInputValue(utcIso: string): string {
  const date = new Date(utcIso);
  const pad = (n: number) => `${n}`.padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export function formatLocal(utcIso: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(utcIso));
}
