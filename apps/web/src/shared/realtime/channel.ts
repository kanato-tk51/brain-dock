export type RealtimeEvent = {
  topic: string;
  payload: unknown;
  receivedAtUtc: string;
};

export type RealtimeHandler = (event: RealtimeEvent) => void;

export interface RealtimeChannel {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(topic: string, handler: RealtimeHandler): () => void;
}

export class NoopRealtimeChannel implements RealtimeChannel {
  private handlers = new Map<string, Set<RealtimeHandler>>();

  async connect(): Promise<void> {
    return;
  }

  async disconnect(): Promise<void> {
    this.handlers.clear();
  }

  subscribe(topic: string, handler: RealtimeHandler): () => void {
    const set = this.handlers.get(topic) ?? new Set<RealtimeHandler>();
    set.add(handler);
    this.handlers.set(topic, set);
    return () => {
      const current = this.handlers.get(topic);
      current?.delete(handler);
      if (current && current.size === 0) {
        this.handlers.delete(topic);
      }
    };
  }
}
