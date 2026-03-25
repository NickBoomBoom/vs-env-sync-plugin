import assert from "node:assert/strict";

import { SerialQueue } from "../src/core/serialQueue";

describe("SerialQueue", () => {
  it("runs tasks in submission order", async () => {
    const queue = new SerialQueue();
    const events: string[] = [];

    await Promise.all([
      queue.enqueue(async () => {
        events.push("task1-start");
        await new Promise((resolve) => setTimeout(resolve, 30));
        events.push("task1-end");
      }),
      queue.enqueue(async () => {
        events.push("task2");
      }),
      queue.enqueue(async () => {
        events.push("task3");
      })
    ]);

    assert.deepEqual(events, ["task1-start", "task1-end", "task2", "task3"]);
  });
});
