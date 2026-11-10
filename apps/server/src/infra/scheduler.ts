import type { LeaseManager } from './leases.ts';

export interface Scheduler {
  /** Runs `fn` every `intervalMs` under the lease `job:<name>`, never overlapping itself. */
  every(name: string, intervalMs: number, fn: () => Promise<void>): void;
  /** Stops scheduling, waits for jobs that are running and gives their leases up. */
  stop(): Promise<void>;
}

interface Job {
  name: string;
  leaseName: string;
  /** Longer than an interval, so the lease survives between runs and a missed tick or two. */
  leaseTtlMs: number;
  fn: () => Promise<void>;
  timer: NodeJS.Timeout | undefined;
  /** The current tick, from taking the lease to the end of the run; set while it is busy. */
  inFlight: Promise<void> | undefined;
}

const LEASE_TTL_INTERVALS = 3;

/**
 * Timer-driven jobs in this process. Each job's lease is taken on its first run and renewed on
 * every tick after that, so while this scheduler lives no other process sharing the lease table
 * runs the same job; another takes over once this one stops or dies and the lease lapses.
 * A job that fails is logged and runs again at the next interval.
 */
export class InProcessScheduler implements Scheduler {
  private readonly jobs = new Map<string, Job>();
  private stopped = false;

  constructor(
    private readonly leases: LeaseManager,
    private readonly logger: { error(o: object, m: string): void },
    private readonly holder: string,
  ) {}

  every(name: string, intervalMs: number, fn: () => Promise<void>): void {
    if (this.stopped) throw new Error(`Cannot schedule "${name}": the scheduler is stopped.`);
    if (this.jobs.has(name)) throw new Error(`Job "${name}" is already scheduled.`);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new Error(`Job "${name}" needs a positive interval, got ${intervalMs}.`);
    }

    const job: Job = {
      name,
      leaseName: `job:${name}`,
      leaseTtlMs: intervalMs * LEASE_TTL_INTERVALS,
      fn,
      timer: undefined,
      inFlight: undefined,
    };
    // Unreferenced: scheduled jobs alone must not keep the process alive.
    job.timer = setInterval(() => this.tick(job), intervalMs).unref();
    this.jobs.set(name, job);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const jobs = [...this.jobs.values()];
    this.jobs.clear();
    for (const job of jobs) clearInterval(job.timer);

    await Promise.all(jobs.map((job) => job.inFlight));
    await Promise.all(
      jobs.map((job) =>
        this.leases.release(job.leaseName, this.holder).catch((err: unknown) => {
          this.logger.error(
            { job: job.name, err },
            `Could not release the lease of job ${job.name}`,
          );
        }),
      ),
    );
  }

  private tick(job: Job): void {
    if (this.stopped) return;
    if (job.inFlight) {
      // Still running: skip this run, but keep the lease alive while a long job goes on.
      void this.leases.renew(job.leaseName, this.holder, job.leaseTtlMs).catch((err: unknown) => {
        this.logger.error({ job: job.name, err }, `Could not renew the lease of job ${job.name}`);
      });
      return;
    }
    job.inFlight = this.run(job).finally(() => {
      job.inFlight = undefined;
    });
  }

  /** Never rejects: every failure is logged. */
  private async run(job: Job): Promise<void> {
    try {
      const held =
        (await this.leases.renew(job.leaseName, this.holder, job.leaseTtlMs)) ||
        (await this.leases.acquire(job.leaseName, this.holder, job.leaseTtlMs));
      if (!held || this.stopped) return;
      await job.fn();
    } catch (err) {
      this.logger.error({ job: job.name, err }, `Scheduled job ${job.name} failed`);
    }
  }
}
