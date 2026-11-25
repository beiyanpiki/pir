/**
 * Executor admission only: callers resolve resource identities and retain
 * ownership of command validation, workspaces, jobs, and persistence.
 */
export type ExecutorScope =
  | { kind: "review"; projectId: string; resourceKey?: string }
  | { kind: "project-exclusive"; projectId: string }
  | { kind: "global-exclusive" };

export interface ExecutorStats {
  /** Includes running tasks, preserving the serve /health pending contract. */
  pending: number;
  oldestPendingMs: number;
}

interface ScheduledTask {
  scope: ExecutorScope;
  queuedAt: number;
  start: () => void;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function copyScope(scope: ExecutorScope): ExecutorScope {
  if (scope.kind === "global-exclusive") return { kind: scope.kind };
  if (scope.kind !== "review" && scope.kind !== "project-exclusive") {
    throw new RangeError("unknown executor scope");
  }
  if (typeof scope.projectId !== "string" || scope.projectId.length === 0) {
    throw new RangeError("executor projectId must not be empty");
  }
  if (scope.kind === "project-exclusive") return { kind: scope.kind, projectId: scope.projectId };
  if (scope.resourceKey !== undefined && (typeof scope.resourceKey !== "string" || scope.resourceKey.length === 0)) {
    throw new RangeError("executor resourceKey must not be empty");
  }
  return { ...scope };
}

/**
 * Bounded, process-local scheduling with project maintenance barriers and
 * optional per-resource exclusion (for a hosted PR's publication lifecycle).
 * Blocked projects do not block unrelated work, but conflicting tasks never
 * overtake an earlier barrier. Slots are reserved before invoking user code.
 */
export class ExecutorScheduler {
  private readonly queue: ScheduledTask[] = [];
  private readonly active = new Set<ScheduledTask>();
  private readonly concurrency: number;
  private readonly projectConcurrency: number;

  constructor(options: { concurrency?: number; projectConcurrency?: number } = {}) {
    this.concurrency = positiveInteger(options.concurrency ?? 1, "executor concurrency");
    this.projectConcurrency = positiveInteger(options.projectConcurrency ?? 1, "project concurrency");
  }

  run<T>(scope: ExecutorScope, task: () => T | Promise<T>): Promise<T> {
    const ownedScope = copyScope(scope);
    return new Promise<T>((resolve, reject) => {
      const entry: ScheduledTask = {
        scope: ownedScope,
        queuedAt: Date.now(),
        start: () => {
          const finish = (): void => {
            this.active.delete(entry);
            this.drain();
          };
          void Promise.resolve().then(task).then(
            (value) => { finish(); resolve(value); },
            (error: unknown) => { finish(); reject(error); },
          );
        },
      };
      this.queue.push(entry);
      this.drain();
    });
  }

  stats(): ExecutorStats {
    let oldest: number | undefined;
    for (const task of [...this.active, ...this.queue]) {
      if (oldest === undefined || task.queuedAt < oldest) oldest = task.queuedAt;
    }
    return {
      pending: this.active.size + this.queue.length,
      oldestPendingMs: oldest === undefined ? 0 : Math.max(0, Date.now() - oldest),
    };
  }

  private canStart(candidate: ScheduledTask, earlier: ScheduledTask[]): boolean {
    const scope = candidate.scope;
    if (scope.kind === "global-exclusive") return this.active.size === 0 && earlier.length === 0;
    let projectActive = 0;
    for (const task of this.active) {
      const other = task.scope;
      if (other.kind === "global-exclusive") return false;
      if (other.projectId !== scope.projectId) continue;
      projectActive++;
      if (scope.kind === "project-exclusive" || other.kind === "project-exclusive") return false;
      if (scope.resourceKey !== undefined && scope.resourceKey === other.resourceKey) return false;
    }
    if (scope.kind === "review" && projectActive >= this.projectConcurrency) return false;
    return !earlier.some(({ scope: other }) => {
      if (other.kind === "global-exclusive") return true;
      if (other.projectId !== scope.projectId) return false;
      if (scope.kind === "project-exclusive" || other.kind === "project-exclusive") return true;
      return scope.resourceKey !== undefined && scope.resourceKey === other.resourceKey;
    });
  }

  private drain(): void {
    for (let index = 0; index < this.queue.length && this.active.size < this.concurrency;) {
      const candidate = this.queue[index]!;
      if (this.canStart(candidate, this.queue.slice(0, index))) {
        this.queue.splice(index, 1);
        this.active.add(candidate);
        candidate.start();
      } else {
        if (candidate.scope.kind === "global-exclusive") break;
        index++;
      }
    }
  }
}
