const { test } = require("node:test");
const assert = require("node:assert/strict");
const { reviewAudit } = require("./check-audit");

function fixture() {
  return {
    lock: {
      packages: {
        "node_modules/eslint": { version: "10.13.0", dev: true },
        "node_modules/@eslint/config-array": { version: "0.23.5", dev: true },
        "node_modules/minimatch": { version: "10.2.6", dev: true },
      },
    },
    report: {
      auditReportVersion: 2,
      vulnerabilities: {
        minimatch: {
          severity: "moderate",
          nodes: ["node_modules/minimatch"],
          via: [
            {
              name: "minimatch",
              severity: "moderate",
              url: "https://github.com/advisories/GHSA-g3hv-75wg-m249",
            },
          ],
        },
        eslint: {
          severity: "moderate",
          nodes: ["node_modules/eslint"],
          via: ["minimatch"],
        },
      },
    },
  };
}

test("reports the exact reviewed development advisory without treating the audit as empty", () => {
  const { report, lock } = fixture();
  const result = reviewAudit(report, lock);
  assert.equal(result.failed, false);
  assert.deepEqual(
    result.deferred.map((item) => item.name),
    ["minimatch", "eslint"],
  );
});

for (const [name, change] of [
  ["production use", (f) => delete f.lock.packages["node_modules/minimatch"].dev],
  ["another advisory", (f) => (f.report.vulnerabilities.minimatch.via[0].url += "-other")],
  ["a severity escalation", (f) => (f.report.vulnerabilities.minimatch.severity = "high")],
  [
    "another minimatch release",
    (f) => (f.lock.packages["node_modules/minimatch"].version = "10.2.5"),
  ],
  ["a changed toolchain", (f) => (f.lock.packages["node_modules/eslint"].version = "10.14.0")],
  ["an unresolved dependency", (f) => f.report.vulnerabilities.eslint.via.push("unknown")],
  [
    "a cycle without advisory evidence",
    (f) => (f.report.vulnerabilities.minimatch.via = ["eslint"]),
  ],
  [
    "mixed accepted and new advisories",
    (f) =>
      f.report.vulnerabilities.minimatch.via.push({
        name: "minimatch",
        severity: "moderate",
        url: "https://github.com/advisories/other",
      }),
  ],
])
  test(`rejects ${name}`, () => {
    const f = fixture();
    change(f);
    assert.equal(reviewAudit(f.report, f.lock).failed, true);
  });

test("rejects unavailable or incompatible audit data", () => {
  const { report, lock } = fixture();
  assert.throws(() => reviewAudit({ error: "unavailable" }, lock));
  assert.throws(() => reviewAudit({ ...report, auditReportVersion: 3 }, lock));
  assert.throws(() => reviewAudit(report, {}));
});
