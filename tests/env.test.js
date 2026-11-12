import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadEnvFile } from "../server/env.js";

test("parses quoted multiline values and preserves existing env", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cloudvm-env-"));
  const file = path.join(dir, ".env");
  const keys = [
    "CLOUDVM_TEST_MULTILINE",
    "CLOUDVM_TEST_SINGLE",
    "CLOUDVM_TEST_ESCAPED",
    "CLOUDVM_TEST_EXISTING",
  ];
  for (const key of keys) {
    delete process.env[key];
  }
  process.env.CLOUDVM_TEST_EXISTING = "keep";

  writeFileSync(
    file,
    [
      "# comment",
      'CLOUDVM_TEST_MULTILINE="-----BEGIN TEST-----',
      "alpha",
      "bravo",
      '-----END TEST-----"',
      'CLOUDVM_TEST_SINGLE="hello world"',
      String.raw`CLOUDVM_TEST_ESCAPED=one\ntwo`,
      "CLOUDVM_TEST_EXISTING=replace",
      "",
    ].join("\n"),
  );

  try {
    loadEnvFile(file);
    assert.equal(
      process.env.CLOUDVM_TEST_MULTILINE,
      "-----BEGIN TEST-----\nalpha\nbravo\n-----END TEST-----",
    );
    assert.equal(process.env.CLOUDVM_TEST_SINGLE, "hello world");
    assert.equal(process.env.CLOUDVM_TEST_ESCAPED, String.raw`one\ntwo`);
    assert.equal(process.env.CLOUDVM_TEST_EXISTING, "keep");
  } finally {
    for (const key of keys) {
      delete process.env[key];
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
