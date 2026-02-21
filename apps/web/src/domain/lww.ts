import type { Entry } from "@/domain/schemas";

export function resolveLww(local: Entry, incoming: Entry): Entry {
  if (incoming.updatedAtUtc >= local.updatedAtUtc) {
    return incoming;
  }
  return local;
}
