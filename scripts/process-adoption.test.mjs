import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (relative) => readFileSync(new URL(relative, `${new URL("..", import.meta.url)}/`), "utf8");
const expectedPolicyJob =
  "  policy-verification:\n" +
  "    name: Policy verification\n" +
  "    if: github.event_name == 'pull_request'\n" +
  "    permissions:\n" +
  "      contents: read\n" +
  "      pull-requests: read\n" +
  "    uses: phuongnse/renovate-ops/.github/workflows/" +
  "policy-verification.yml@38d952b8c94604df10fadc48b6c830a144ea1137\n";
const extractPolicyJob = (workflow) => {
  const marker = "  policy-verification:\n";
  const nextJob = "\n  process-contract:";
  if (!workflow.includes(marker) || !workflow.includes(nextJob)) return null;
  return marker + workflow.split(marker, 2)[1].split(nextJob, 1)[0];
};

test("process updates are materialized by the managed runner", () => {
  const renovate = JSON.parse(read(".github/renovate.json5"));

  assert.equal(renovate.enabled, true);
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
  assert.equal(rule.enabled, true);
  assert.equal(rule.draftPR, true);
  assert.deepEqual(rule.schedule, ["at any time"]);
  assert.equal(rule.prPriority, 100);
  assert.deepEqual(rule.matchFileNames, [
    "requirements/process.in",
    "requirements/process.txt",
  ]);
  assert.deepEqual(rule.matchPackageNames, [
    "engineering-process",
  ]);
  assert.deepEqual(rule.postUpgradeTasks.commands, [
    "python .process/adopt-process.py --project-root . --requirements-lock requirements/process.txt",
  ]);
  assert.equal(rule.postUpgradeTasks.executionMode, "update");
  assert.ok(rule.postUpgradeTasks.fileFilters.includes(".agents/skills/**"));
  const majorApprovalRule = renovate.packageRules.find(
    (candidate) => candidate.matchUpdateTypes?.includes("major")
      && candidate.dependencyDashboardApproval === true,
  );
  assert.ok(majorApprovalRule);
  assert.deepEqual(majorApprovalRule.matchPackageNames, ["!engineering-process"]);
  assert.deepEqual(majorApprovalRule.matchUpdateTypes, ["major"]);
  assert.equal(majorApprovalRule.dependencyDashboardApproval, true);

  assert.match(
    read("requirements/process.in"),
    /^engineering-process==[0-9]+\.[0-9]+\.[0-9]+$/m,
  );
  assert.match(read("requirements/process.txt"), /pip-compile /);
  assert.match(read("requirements/process.txt"), /--generate-hashes/);
  assert.ok(existsSync(`${root}/.process/adopt-process.py`));
  const workflow = read(".github/workflows/ci.yml");
  const security = read(".github/workflows/dependency-security.yml");
  assert.equal(extractPolicyJob(workflow), expectedPolicyJob);
  assert.doesNotMatch(workflow, /independent-review\.yml/);
  assert.match(workflow, /processctl adoption check/);
  assert.match(workflow, /automation\/renovate\/engineering-process/);
  assert.equal(workflow.match(/python -m pip install/g)?.length, 2);
  assert.equal(workflow.match(/--require-hashes/g)?.length, 2);
  assert.match(security, /python -m pip install/);
  assert.match(security, /--require-hashes/);
  assert.doesNotMatch(`${workflow}\n${security}`, /scripts\/install_process_runtime\.py/);
  assert.equal(existsSync(`${root}/scripts/install_process_runtime.py`), false);
});

test("policy caller rejects trust-root and permission mutations", () => {
  const workflow = read(".github/workflows/ci.yml");
  const mutations = {
    "untrusted owner": workflow.replace(
      "phuongnse/renovate-ops/",
      "attacker/renovate-ops/",
    ),
    "changed revision": workflow.replace(
      "38d952b8c94604df10fadc48b6c830a144ea1137",
      "1e3d0d333b62ec92c94ea5c355bbb0cd73024b79",
    ),
    "write permissions": workflow.replace(
      "contents: read\n      pull-requests: read",
      "contents: write\n      pull-requests: write",
    ),
    "extra permission": workflow.replace(
      "pull-requests: read\n    uses:",
      "pull-requests: read\n      issues: write\n    uses:",
    ),
    "push event": workflow.replace(
      "    if: github.event_name == 'pull_request'\n",
      "",
    ),
  };

  assert.equal(extractPolicyJob(workflow), expectedPolicyJob);
  for (const [name, mutation] of Object.entries(mutations)) {
    assert.notEqual(extractPolicyJob(mutation), expectedPolicyJob, name);
  }
});
