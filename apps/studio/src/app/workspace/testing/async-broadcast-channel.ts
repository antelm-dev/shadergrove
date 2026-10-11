/**
 * A `BroadcastChannel` that delivers like the real one: each message in its
 * own task, later, structured-cloned, in the order it was posted. Install with
 * `vi.stubGlobal('BroadcastChannel', AsyncBroadcastChannel)`; let messages land
 * by awaiting a few `setTimeout(0)` turns.
 */
export class AsyncBroadcastChannel {
  static readonly open = new Set<AsyncBroadcastChannel>();

  onmessage: ((event: MessageEvent) => void) | null = null;
  closed = false;

  constructor(readonly name: string) {
    AsyncBroadcastChannel.open.add(this);
  }

  postMessage(data: unknown): void {
    if (this.closed) throw new Error('InvalidStateError: channel is closed');
    for (const other of AsyncBroadcastChannel.open) {
      if (other === this || other.name !== this.name) continue;
      const copy = structuredClone(data);
      setTimeout(() => {
        if (!other.closed) other.onmessage?.({ data: copy } as MessageEvent);
      });
    }
  }

  close(): void {
    this.closed = true;
    AsyncBroadcastChannel.open.delete(this);
  }

  static reset(): void {
    AsyncBroadcastChannel.open.clear();
  }
}
