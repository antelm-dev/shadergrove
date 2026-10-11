/**
 * An in-memory `BroadcastChannel`: a post reaches every other open channel of
 * the same name, synchronously and structured-cloned like the real thing.
 * Install with `vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)`.
 */
export class FakeBroadcastChannel {
  static readonly open = new Set<FakeBroadcastChannel>();

  onmessage: ((event: MessageEvent) => void) | null = null;
  closed = false;

  constructor(readonly name: string) {
    FakeBroadcastChannel.open.add(this);
  }

  postMessage(data: unknown): void {
    if (this.closed) throw new Error('InvalidStateError: channel is closed');
    for (const other of FakeBroadcastChannel.open) {
      if (other === this || other.name !== this.name) continue;
      other.onmessage?.({ data: structuredClone(data) } as MessageEvent);
    }
  }

  close(): void {
    this.closed = true;
    FakeBroadcastChannel.open.delete(this);
  }

  static reset(): void {
    FakeBroadcastChannel.open.clear();
  }
}
