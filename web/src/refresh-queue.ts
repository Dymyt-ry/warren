/**
 * Coalesces REST snapshot refreshes and guarantees one extra pass when an SSE
 * event arrives while a snapshot is in flight. That second pass prevents an
 * older response from overwriting the event that was just applied locally.
 */
export class SnapshotRefreshQueue {
  private running = false;
  private rerun = false;
  private includeMe = false;
  private includeAudit = false;
  private current: Promise<void> | null = null;

  constructor(private readonly work: (options: { includeMe: boolean; includeAudit: boolean }) => Promise<void>) {}

  request(includeMe = false, includeAudit = false): Promise<void> {
    this.includeMe ||= includeMe;
    this.includeAudit ||= includeAudit;
    if (this.running) {
      this.rerun = true;
      return this.current!;
    }
    this.running = true;
    this.current = this.drain();
    return this.current;
  }

  noteEvent() {
    if (this.running) this.rerun = true;
  }

  private async drain() {
    try {
      do {
        const options = { includeMe: this.includeMe, includeAudit: this.includeAudit };
        this.includeMe = false;
        this.includeAudit = false;
        this.rerun = false;
        await this.work(options);
      } while (this.rerun);
    } finally {
      this.running = false;
      this.current = null;
    }
  }
}
