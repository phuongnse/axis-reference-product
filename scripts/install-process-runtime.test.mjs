import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) =>
  readFileSync(new URL(relative, `${new URL("..", import.meta.url)}/`), "utf8");

test("process runtime installer owns strict bounded retry semantics", () => {
  const result = spawnSync(
    "python",
    [
      "-c",
      [
        "from pathlib import Path",
        "from scripts.install_process_runtime import Attempt, BACKOFF_SECONDS, PUBLIC_INDEX, pip_command, retryable_exact_version_absence",
        "version = '0.2.1'",
        "transient = Attempt(1, b'', b'Could not find a version that satisfies the requirement engineering-process==0.2.1\\nNo matching distribution found for engineering-process==0.2.1\\n')",
        "assert retryable_exact_version_absence(transient, version)",
        "assert not retryable_exact_version_absence(Attempt(1, b'', b'THESE PACKAGES DO NOT MATCH THE HASHES'), version)",
        "assert not retryable_exact_version_absence(Attempt(-1, b'', b'', timed_out=True), version)",
        "assert BACKOFF_SECONDS == (10, 20, 40, 80, 160)",
        "command = pip_command(Path('requirements/process.txt'))",
        "assert '--require-hashes' in command and '--no-cache-dir' in command",
        "assert command[command.index('--index-url') + 1] == PUBLIC_INDEX",
      ].join("; "),
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    },
  );

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const workflow = read(".github/workflows/ci.yml");
  const security = read(".github/workflows/dependency-security.yml");
  assert.equal(
    workflow.match(/python scripts\/install_process_runtime\.py/g)?.length,
    2,
  );
  assert.match(security, /python scripts\/install_process_runtime\.py/);
  assert.doesNotMatch(
    `${workflow}\n${security}`,
    /python -m pip install --require-hashes -r requirements\/process\.txt/,
  );
});
