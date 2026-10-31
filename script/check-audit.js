const fs = require("node:fs");
const path = require("node:path");

const acceptedAdvisory = "https://github.com/advisories/GHSA-g3hv-75wg-m249";
const reviewedTools = {
  "node_modules/eslint": "10.13.0",
  "node_modules/@eslint/config-array": "0.23.5",
};

function reviewAudit(report, lock) {
  if (
    report?.error ||
    report?.auditReportVersion !== 2 ||
    !report.vulnerabilities ||
    Array.isArray(report.vulnerabilities) ||
    !lock?.packages
  )
    throw new Error("A complete npm audit v2 report and package lock are required");

  const reviewedToolchain = Object.entries(reviewedTools).every(
    ([name, version]) =>
      lock.packages[name]?.dev === true && lock.packages[name].version === version,
  );
  const inspect = (name, seen, evidence) => {
    if (seen.has(name)) return true;
    const item = report.vulnerabilities[name];
    if (
      !reviewedToolchain ||
      item?.severity !== "moderate" ||
      !item.nodes?.length ||
      !item.nodes.every((node) => lock.packages[node]?.dev === true) ||
      !item.via?.length
    )
      return false;
    seen.add(name);
    return item.via.every((cause) => {
      if (typeof cause === "string") return inspect(cause, seen, evidence);
      const known =
        cause.url === acceptedAdvisory &&
        cause.name === "minimatch" &&
        cause.severity === "moderate" &&
        report.vulnerabilities.minimatch?.nodes?.every(
          (node) => lock.packages[node]?.version === "10.2.6",
        );
      if (known) evidence.known = true;
      return known;
    });
  };

  const deferred = [],
    findings = [];
  for (const [name, item] of Object.entries(report.vulnerabilities)) {
    if (item.severity === "info" || item.severity === "low") continue;
    const evidence = { known: false };
    const accepted = inspect(name, new Set(), evidence) && evidence.known;
    (accepted ? deferred : findings).push({ name, ...item });
  }
  return { deferred, findings, failed: findings.length > 0 };
}

if (require.main === module) {
  try {
    const read = (file) => JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    const result = reviewAudit(
      read(process.argv[2]),
      read(process.argv[3] ?? path.resolve(__dirname, "../package-lock.json")),
    );
    console.log(JSON.stringify(result, null, 2));
    if (result.deferred.length)
      console.log(
        `Deferred development-only advisory: ${acceptedAdvisory}; see docs/dependency-audit.md`,
      );
    if (result.failed) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { reviewAudit };
