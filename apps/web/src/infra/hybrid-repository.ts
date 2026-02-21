import type { EntryRepository } from "@/domain/repository";
import { LocalRepository } from "@/infra/local-repository";

export class HybridRepository extends LocalRepository implements EntryRepository {
  // UI v1 keeps local-first behavior. Remote bridge is added in the next phase.
}
