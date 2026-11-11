/**
 * The live-update streams open in this process, so that shutting down can end them: an open
 * stream holds its connection, and with it the server's close, until it ends.
 */
export class LiveStreams {
  private readonly open = new Set<{ end: () => void }>();
  private closed = false;

  /** How many streams are open. */
  get size(): number {
    return this.open.size;
  }

  /**
   * Tracks a stream that `end` closes, until the returned function is called. Once `closeAll`
   * has run, `end` runs at once instead.
   */
  add(end: () => void): () => void {
    if (this.closed) {
      end();
      return () => {};
    }
    // Its own object, so the same function added twice is two streams.
    const entry = { end };
    this.open.add(entry);
    return () => {
      this.open.delete(entry);
    };
  }

  /** Ends every open stream, and every stream added from now on. */
  closeAll(): void {
    this.closed = true;
    const entries = [...this.open];
    this.open.clear();
    for (const { end } of entries) end();
  }
}
