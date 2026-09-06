/** Presentation-only fallback. Never sampled in a hidden tab or used for game timing. */
export class FrameHealth {
  private previous: number | null = null;
  private samples = 0;
  private slow = 0;
  private degraded = false;

  isDegraded(): boolean { return this.degraded; }

  resetWindow(): void { this.previous = null; this.samples = 0; this.slow = 0; }

  sample(now: number): boolean {
    if (this.degraded) return true;
    if (this.previous !== null) {
      const elapsed = now - this.previous;
      if (elapsed > 34) this.slow += 1;
      this.samples += 1;
      // Six missed double-frame budgets in a 24-frame sample means sustained
      // pressure, not a single GC/layout pause. Keep the choice for this table.
      if (this.samples >= 24) {
        this.degraded = this.slow >= 6;
        this.resetWindow();
      }
    }
    this.previous = now;
    return this.degraded;
  }
}
