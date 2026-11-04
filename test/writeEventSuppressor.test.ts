import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { WriteEventSuppressor } from "../src/core/writeEventSuppressor";

describe("WriteEventSuppressor", () => {
  it("suppresses only the expected write once", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-suppressor-"));
    const file = path.join(root, ".env");
    const suppressor = new WriteEventSuppressor();
    suppressor.expectWrite(file, Buffer.from("REMOTE=1\n"));
    await fs.writeFile(file, "REMOTE=1\n");

    assert.equal(await suppressor.shouldSuppress(file), true);
    assert.equal(await suppressor.shouldSuppress(file), false);
  });

  it("processes a user edit that differs from the extension write", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-suppressor-edit-"));
    const file = path.join(root, ".env");
    const suppressor = new WriteEventSuppressor();
    suppressor.expectWrite(file, Buffer.from("REMOTE=1\n"));
    await fs.writeFile(file, "USER=1\n");

    assert.equal(await suppressor.shouldSuppress(file), false);
  });

  it("suppresses expected deletion but not a recreated file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "env-sync-suppressor-delete-"));
    const file = path.join(root, ".env");
    const suppressor = new WriteEventSuppressor();
    suppressor.expectDelete(file);
    assert.equal(await suppressor.shouldSuppress(file), true);

    suppressor.expectDelete(file);
    await fs.writeFile(file, "USER=1\n");
    assert.equal(await suppressor.shouldSuppress(file), false);
  });
});
