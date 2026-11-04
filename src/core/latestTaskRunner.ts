interface Waiter {
  resolve: () => void;
  reject: (error: unknown) => void;
}

export class LatestTaskRunner {
  private running = false;
  private latestTask: (() => Promise<void>) | undefined;
  private waiters: Waiter[] = [];

  async run(task: () => Promise<void>): Promise<void> {
    if (this.running) {
      this.latestTask = task;
      return new Promise<void>((resolve, reject) => {
        this.waiters.push({ resolve, reject });
      });
    }

    this.running = true;
    let initialError: unknown;
    try {
      await task();
    } catch (error) {
      initialError = error;
    }

    while (this.latestTask) {
      const nextTask = this.latestTask;
      const waiters = this.waiters;
      this.latestTask = undefined;
      this.waiters = [];
      try {
        await nextTask();
        for (const waiter of waiters) {
          waiter.resolve();
        }
      } catch (error) {
        for (const waiter of waiters) {
          waiter.reject(error);
        }
      }
    }

    this.running = false;
    if (initialError) {
      throw initialError;
    }
  }
}
