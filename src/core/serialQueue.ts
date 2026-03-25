export class SerialQueue {
  private chain = Promise.resolve();

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task);
    this.chain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}
