import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnvFile } from "../src/env";

describe("Environment file loading", () => {
  const originalValue = process.env.MODEL_ROUTER_ENV_TEST;

  afterEach(() => {
    if (originalValue === undefined) process.env.MODEL_ROUTER_ENV_TEST = undefined;
    else process.env.MODEL_ROUTER_ENV_TEST = originalValue;
  });

  it("loads values without overriding the process environment", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "model-router-env-"));
    const filePath = path.join(directory, ".env");
    fs.writeFileSync(filePath, 'MODEL_ROUTER_ENV_TEST="from-file"\n');
    process.env.MODEL_ROUTER_ENV_TEST = "from-process";

    loadEnvFile(filePath);

    expect(process.env.MODEL_ROUTER_ENV_TEST).toBe("from-process");
    fs.rmSync(directory, { recursive: true, force: true });
  });
});
