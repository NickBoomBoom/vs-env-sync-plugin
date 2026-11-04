import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

interface WriteExpectation {
  hash: string | undefined;
}

export class WriteEventSuppressor {
  private readonly expectations = new Map<string, WriteExpectation>();

  expectWrite(targetPath: string, content: Buffer): void {
    this.expectations.set(path.resolve(targetPath), {
      hash: createHash("sha256").update(content).digest("hex")
    });
  }

  expectDelete(targetPath: string): void {
    this.expectations.set(path.resolve(targetPath), { hash: undefined });
  }

  async shouldSuppress(targetPath: string): Promise<boolean> {
    const normalizedPath = path.resolve(targetPath);
    const expectation = this.expectations.get(normalizedPath);
    if (!expectation) {
      return false;
    }
    this.expectations.delete(normalizedPath);

    try {
      const content = await fs.readFile(normalizedPath);
      const actualHash = createHash("sha256").update(content).digest("hex");
      return expectation.hash === actualHash;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return expectation.hash === undefined;
      }
      return false;
    }
  }
}
