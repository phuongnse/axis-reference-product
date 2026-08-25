import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(new URL(relative, `${new URL("..", import.meta.url)}/`), "utf8");
const expectedPolicyJob =
  "  policy-verification:\n" +
  "    name: policy-verification\n" +
  "    permissions:\n" +
  "      contents: read\n" +
  "      pull-requests: read\n" +
  "    uses: phuongnse/renovate-ops/.github/workflows/" +
  "policy-verification.yml@2152dab51edd6c84163a71b48f50e6ad042eb331\n";
const extractPolicyJob = (workflow) => {
  const marker = "  policy-verification:\n";
  const nextJob = "\n  process-contract:";
  if (!workflow.includes(marker) || !workflow.includes(nextJob)) return null;
  return marker + workflow.split(marker, 2)[1].split(nextJob, 1)[0];
};

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
  assert.equal(extractPolicyJob(workflow), expectedPolicyJob);
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

test("policy caller rejects trust-root and permission mutations", () => {
  const workflow = read(".github/workflows/ci.yml");
  const mutations = {
    "untrusted owner": workflow.replace(
      "phuongnse/renovate-ops/",
      "attacker/renovate-ops/",
    ),
    "changed revision": workflow.replace(
      "2152dab51edd6c84163a71b48f50e6ad042eb331",
      "2152dab51edd6c84163a71b48f50e6ad042eb330",
    ),
    "write permissions": workflow.replace(
      "contents: read\n      pull-requests: read",
      "contents: write\n      pull-requests: write",
    ),
    "extra permission": workflow.replace(
      "pull-requests: read\n    uses:",
      "pull-requests: read\n      issues: write\n    uses:",
    ),
  };

  assert.equal(extractPolicyJob(workflow), expectedPolicyJob);
  for (const [name, mutation] of Object.entries(mutations)) {
    assert.notEqual(extractPolicyJob(mutation), expectedPolicyJob, name);
  }
});
