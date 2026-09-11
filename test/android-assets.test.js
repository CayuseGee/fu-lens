import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

test("Android archives normalize raw ZIP paths and reject corrupt/missing assets", { skip: process.platform !== "win32" }, async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "fu-lens-asset-test-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  for (const [name, value] of [["index.html", "page"], ["vendor/ort-1.17.3/ort.wasm.min.js", "runtime"], ["models/nano/model.onnx", "model"]]) {
    const target = join(scratch, "public", name);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, value);
  }
  const result = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    fileURLToPath(new URL("./android-assets.ps1", import.meta.url)), "-ScratchDirectory", scratch],
  { encoding: "utf8", windowsHide: true, timeout: 30000 });
  assert.match(result, /regression checks passed/);
});
