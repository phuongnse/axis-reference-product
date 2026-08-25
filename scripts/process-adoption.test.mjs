import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(new URL(relative, `${new URL("..", import.meta.url)}/`), "utf8");

test("process updates are reserved for the pre-publication lifecycle host", () => {
  const renovate = JSON.parse(read(".github/renovate.json5"));

  assert.equal(renovate.enabled, true);
  assert.equal(renovate.automerge, false);
  assert.equal(renovate.draftPR, true);
  assert.equal(renovate.branchPrefix, "automation/renovate/");
  assert.ok(renovate.enabledManagers.includes("pip-compile"));
  assert.equal(renovate.pip_requirements.enabled, false);
  assert.deepEqual(renovate["pip-compile"].managerFilePatterns, [
    "/^requirements\\/process\\.txt$/",
  ]);
  assert.equal("postUpgradeTasks" in renovate, false);
  const rule = renovate.packageRules.find(
    (candidate) => candidate.matchPackageNames?.includes("engineering-process"),
  );
  assert.ok(rule);
  assert.equal(rule.enabled, false);
  assert.equal(rule.automerge, false);
  assert.deepEqual(rule.schedule, ["at any time"]);
  assert.equal(rule.prPriority, 100);
  assert.deepEqual(rule.matchFileNames, [
    ".github/workflows/ci.yml",
    ".github/workflows/dependency-security.yml",
    "requirements/process.in",
    "requirements/process.txt",
  ]);
  assert.deepEqual(rule.matchPackageNames, [
    "engineering-process",
    "phuongnse/engineering-process",
  ]);

  assert.match(
    read("requirements/process.in"),
    /^engineering-process==[0-9]+\.[0-9]+\.[0-9]+$/m,
  );
  assert.match(read("requirements/process.txt"), /pip-compile /);
  assert.match(read("requirements/process.txt"), /--generate-hashes/);
  assert.ok(existsSync(`${root}/.process/adopt-process.py`));
  assert.ok(existsSync(`${root}/.process/adopt-process-windows-job.py`));
  const workflow = read(".github/workflows/ci.yml");
  const security = read(".github/workflows/dependency-security.yml");
  const policyJob = workflow
    .split("  policy-verification:\n", 2)[1]
    .split("\n  process-contract:", 1)[0];
  assert.match(
    policyJob,
    /uses: phuongnse\/renovate-ops\/\.github\/workflows\/policy-verification\.yml@2152dab51edd6c84163a71b48f50e6ad042eb331/,
  );
  assert.match(policyJob, /permissions:\n      contents: read\n      pull-requests: read/);
  assert.doesNotMatch(policyJob, /(?:contents|pull-requests): write/);
  assert.doesNotMatch(workflow, /independent-review\.yml/);
  assert.match(workflow, /processctl adoption check/);
  assert.match(workflow, /automation\/process\/engineering-process/);
  assert.doesNotMatch(workflow, /automation\/renovate\/engineering-process/);
  assert.equal(
    workflow.match(/uses: phuongnse\/engineering-process@[0-9a-f]{40}/g)?.length,
    2,
  );
  assert.match(security, /uses: phuongnse\/engineering-process@[0-9a-f]{40}/);
  assert.doesNotMatch(`${workflow}\n${security}`, /scripts\/install_process_runtime\.py/);
  assert.equal(existsSync(`${root}/scripts/install_process_runtime.py`), false);
  assert.doesNotMatch(
    workflow,
    /python -m pip install --require-hashes -r requirements\/process\.txt/,
  );
});
