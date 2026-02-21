import type { EntryRepository } from "@/domain/repository";
import { HybridRepository } from "@/infra/hybrid-repository";
import { LocalRepository } from "@/infra/local-repository";
import { RemoteRepository } from "@/infra/remote-repository";

type RepositoryMode = "local" | "remote" | "hybrid";

let singleton: EntryRepository | null = null;

function resolveMode(): RepositoryMode {
  const raw = (process.env.NEXT_PUBLIC_REPOSITORY_MODE ?? "hybrid").toLowerCase();
  if (raw === "local" || raw === "remote" || raw === "hybrid") {
    return raw;
  }
  return "hybrid";
}

export function getRepository(): EntryRepository {
  if (!singleton) {
    const mode = resolveMode();
    if (mode === "local") {
      singleton = new LocalRepository();
    } else if (mode === "remote") {
      singleton = new RemoteRepository();
    } else {
      singleton = new HybridRepository();
    }
  }
  return singleton;
}
