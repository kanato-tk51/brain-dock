import { HybridRepository } from "@/infra/hybrid-repository";

let singleton: HybridRepository | null = null;

export function getRepository(): HybridRepository {
  if (!singleton) {
    singleton = new HybridRepository();
  }
  return singleton;
}
