/**
 * EventHub — monotonic event bus with replay buffer.
 */
import { systemClock } from '@neo/protocol';
import type { Clock, EventEnvelope, ServerEvent } from '@neo/protocol';

const BUFFER_SIZE = 500;

export class EventHub {
  private _seq = 0;
  private _buffer: EventEnvelope[] = [];
  private _listeners = new Set<(e: EventEnvelope) => void>();

  constructor(private readonly clock: Clock = systemClock) {}

  publish(event: ServerEvent): EventEnvelope {
    const envelope: EventEnvelope = { seq: ++this._seq, at: this.clock(), event };
    this._buffer.push(envelope);
    if (this._buffer.length > BUFFER_SIZE) {
      this._buffer.shift();
    }
    for (const listener of [...this._listeners]) {
      try {
        listener(envelope);
      } catch {
        // ignore listener errors
      }
    }
    return envelope;
  }

  subscribe(listener: (envelope: EventEnvelope) => void): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  since(seq: number): EventEnvelope[] {
    return this._buffer.filter((e) => e.seq > seq);
  }

  get seq(): number {
    return this._seq;
  }
}
