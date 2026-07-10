export interface BoundedChunkBufferOptions<T> {
  maxChars: number;
  maxChunks: number;
  textOf: (chunk: T) => string;
  withText: (chunk: T, text: string) => T;
  compare?: (left: T, right: T) => number;
  same?: (left: T, right: T) => boolean;
}

/** A tail buffer bounded by both retained text and retained chunk objects. */
export class BoundedChunkBuffer<T> {
  private chunks: T[] = [];
  private head = 0;
  private retainedChars = 0;
  private cachedValues: readonly T[] | undefined;
  private dropped = 0;
  private revision = 0;

  constructor(private readonly options: BoundedChunkBufferOptions<T>) {}

  get length(): number {
    return this.chunks.length - this.head;
  }

  get droppedChars(): number {
    return this.dropped;
  }

  get version(): number {
    return this.revision;
  }

  values(): readonly T[] {
    this.cachedValues ??= this.chunks.slice(this.head);
    return this.cachedValues;
  }

  append(chunk: T): boolean {
    const same = this.options.same;
    if (same) {
      for (let index = this.head; index < this.chunks.length; index += 1) {
        const candidate = this.chunks[index];
        if (candidate !== undefined && same(candidate, chunk)) return false;
      }
    }

    this.insert(chunk);
    this.retainedChars += this.options.textOf(chunk).length;
    this.trim();
    this.revision += 1;
    this.cachedValues = undefined;
    return true;
  }

  private insert(chunk: T): void {
    const compare = this.options.compare;
    const last = this.chunks[this.chunks.length - 1];
    if (!compare || last === undefined || compare(last, chunk) <= 0) {
      this.chunks.push(chunk);
      return;
    }

    this.compactStorage(true);
    const index = this.chunks.findIndex((candidate) => compare(candidate, chunk) > 0);
    this.chunks.splice(index < 0 ? this.chunks.length : index, 0, chunk);
  }

  private trim(): void {
    let excess = this.retainedChars - this.options.maxChars;
    while (excess > 0 && this.length > 0) {
      const first = this.chunks[this.head];
      if (first === undefined) break;
      const text = this.options.textOf(first);
      if (text.length <= excess) {
        this.dropFirst(text.length);
        excess -= text.length;
        continue;
      }
      this.chunks[this.head] = this.options.withText(first, text.slice(excess));
      this.retainedChars -= excess;
      this.dropped += excess;
      excess = 0;
    }
    while (this.length > this.options.maxChunks) {
      const first = this.chunks[this.head];
      this.dropFirst(first === undefined ? 0 : this.options.textOf(first).length);
    }
    this.compactStorage(false);
  }

  private dropFirst(chars: number): void {
    this.head += 1;
    this.retainedChars -= chars;
    this.dropped += chars;
  }

  private compactStorage(force: boolean): void {
    if (this.head === 0) return;
    if (!force && (this.head < 64 || this.head * 2 < this.chunks.length)) return;
    this.chunks.splice(0, this.head);
    this.head = 0;
  }
}
