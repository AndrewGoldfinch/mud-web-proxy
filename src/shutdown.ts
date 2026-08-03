// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Ordered, bounded, idempotent shutdown (MWP-96).
 *
 * What makes a restart safe under a load balancer or orchestrator is not
 * closing everything, but *when* each thing closes: become unready, wait long
 * enough for the balancer to notice, and only then take capacity away. Skipping
 * that wait is the ordinary cause of errors during a deploy — the process stops
 * accepting connections while traffic is still being routed to it.
 *
 * The sequence lives here rather than inline in a signal handler so the
 * ordering, the deadline and the idempotency can be tested without sockets,
 * signals, or real elapsed time. The caller supplies the steps; this owns only
 * the guarantees about how they are run.
 */

export interface ShutdownStep {
  /** Named so a drain that hangs says which step it is stuck on. */
  name: string;
  run: () => void | Promise<void>;
}

export interface ShutdownOptions {
  steps: ShutdownStep[];
  /**
   * Absolute budget for the whole sequence. Exceeding it completes anyway: an
   * orchestrator SIGKILLing a container that will not exit is a worse outcome
   * than dropping a connection slightly early.
   */
  deadlineMs: number;
  /** Called exactly once, whichever way the sequence ends. */
  onComplete: (reason: 'completed' | 'deadline') => void;
  log?: (message: string) => void;
}

export class ShutdownCoordinator {
  private started = false;
  private finished = false;

  constructor(private readonly options: ShutdownOptions) {}

  /** True once a shutdown has begun, for code that must behave differently. */
  isShuttingDown(): boolean {
    return this.started;
  }

  /**
   * Run the sequence. Safe to call repeatedly: operators and orchestrators both
   * send more than one signal, and re-entering would restart the drain and —
   * worse — reset the deadline, so a process could be kept alive indefinitely
   * by repeated signals.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const { steps, deadlineMs, log } = this.options;

    // start() must resolve when the deadline fires, not when the steps finish.
    // Awaiting the step loop directly meant one hung step blocked the caller
    // forever — so process.exit was never reached and the deadline achieved
    // nothing, which is the exact failure this sequence exists to prevent.
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadlineReached = new Promise<void>((resolve) => {
      deadlineTimer = setTimeout(() => {
        this.finish('deadline');
        resolve();
      }, deadlineMs);
      // Never hold the event loop open on account of the timer whose job is to
      // close things down.
      deadlineTimer.unref?.();
    });

    const stepsFinished = (async () => {
      for (const step of steps) {
        if (this.finished) break;
        log?.(`shutdown: ${step.name}`);
        try {
          await step.run();
        } catch (err) {
          // Best effort. Abandoning the sequence because one socket refused to
          // close would leave listeners bound and state unflushed — the failure
          // this ordering exists to avoid.
          log?.(
            `shutdown: ${step.name} failed: ${(err as Error).message ?? String(err)}`,
          );
        }
      }
      if (deadlineTimer) clearTimeout(deadlineTimer);
      this.finish('completed');
    })();

    await Promise.race([stepsFinished, deadlineReached]);
  }

  /**
   * Both the deadline timer and the step loop can reach the end, so completion
   * is guarded: calling onComplete twice would mean exiting twice.
   */
  private finish(reason: 'completed' | 'deadline'): void {
    if (this.finished) return;
    this.finished = true;
    this.options.log?.(`shutdown: ${reason}`);
    this.options.onComplete(reason);
  }
}
