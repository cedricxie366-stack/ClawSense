#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(new URL("..", import.meta.url).pathname);
const reportDir = process.env.STAGE_FINAL_REPORT_DIR
  ? path.resolve(process.env.STAGE_FINAL_REPORT_DIR)
  : path.join(rootDir, ".local", "stage-final-reports");

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return { parseError: String(error?.message || error) };
  }
}

function isFixturePath(value) {
  const text = String(value || "");
  return (
    text.includes("/var/folders/") ||
    text.includes("/tmp/") ||
    text.includes("\\Temp\\") ||
    text.includes("\\tmp\\")
  );
}

function classifyReport(filePath) {
  const stat = fs.statSync(filePath);
  const data = readJson(filePath);
  const fixtureLike =
    isFixturePath(data.phaseReport) ||
    isFixturePath(data.androidLiveReport) ||
    isFixturePath(data.androidNoArmReport) ||
    isFixturePath(data.androidAutoVideoReport) ||
    isFixturePath(data.path);
  const failure = data.failure || (Array.isArray(data.failures) && data.failures.length > 0 ? data.failures.join("; ") : "");
  return {
    file: filePath,
    name: path.basename(filePath),
    mtimeMs: stat.mtimeMs,
    generatedAt: Number(data.generatedAt || 0) || null,
    ok: data.ok === true,
    kind: fixtureLike ? "fixture-smoke" : "real",
    failure: failure || null,
    phaseReport: data.phaseReport || null,
    androidLiveReport: data.androidLiveReport || null,
    androidNoArmReport: data.androidNoArmReport || null,
    androidAutoVideoReport: data.androidAutoVideoReport || null,
    latestPreflightReport: data.latestPreflightReport || null,
  };
}

function formatTime(value) {
  if (!value) return "-";
  return new Date(value).toISOString();
}

fs.mkdirSync(reportDir, { recursive: true });
const reports = fs
  .readdirSync(reportDir)
  .filter((name) => /^stage-final-.*\.json$/.test(name))
  .map((name) => classifyReport(path.join(reportDir, name)))
  .sort((a, b) => b.mtimeMs - a.mtimeMs);

const realReports = reports.filter((report) => report.kind === "real");
const fixtureReports = reports.filter((report) => report.kind === "fixture-smoke");
const latestReal = realReports[0] || null;
const latestFixture = fixtureReports[0] || null;
const summary = {
  ok: true,
  generatedAt: Date.now(),
  reportDir,
  counts: {
    total: reports.length,
    real: realReports.length,
    fixtureSmoke: fixtureReports.length,
  },
  latestReal,
  latestFixture,
  warnings: [
    ...(fixtureReports.length > 0
      ? ["fixture-smoke reports exist in this directory; ignore them for final stage completion."]
      : []),
    ...(!latestReal ? ["no real stage-final report found."] : []),
    ...(latestReal && latestReal.ok !== true ? ["latest real stage-final report is not passing."] : []),
  ],
  reports,
};

const indexJson = path.join(reportDir, "INDEX.json");
const indexMd = path.join(reportDir, "INDEX.md");
fs.writeFileSync(indexJson, `${JSON.stringify(summary, null, 2)}\n`);

const lines = [
  "# Stage Final Reports Index",
  "",
  `Generated: ${formatTime(summary.generatedAt)}`,
  `Report dir: \`${reportDir}\``,
  "",
  "## Summary",
  "",
  `- Total reports: ${summary.counts.total}`,
  `- Real reports: ${summary.counts.real}`,
  `- Fixture smoke reports: ${summary.counts.fixtureSmoke}`,
  `- Latest real report: ${latestReal ? `\`${latestReal.name}\`` : "<missing>"}`,
  `- Latest real status: ${latestReal ? (latestReal.ok ? "pass" : "failed") : "missing"}`,
  "",
];

if (summary.warnings.length > 0) {
  lines.push("## Warnings", "");
  for (const warning of summary.warnings) {
    lines.push(`- ${warning}`);
  }
  lines.push("");
}

lines.push("## Reports", "");
lines.push("| File | Kind | Status | Failure | Generated |");
lines.push("| --- | --- | --- | --- | --- |");
for (const report of reports) {
  const failure = String(report.failure || "").replace(/\|/g, "\\|") || "-";
  lines.push(
    `| \`${report.name}\` | ${report.kind} | ${report.ok ? "pass" : "failed"} | ${failure} | ${formatTime(
      report.generatedAt,
    )} |`,
  );
}
lines.push("");
lines.push("## Android Evidence Reports", "");
lines.push("| File | Android live | No-arm ambient | Auto-video |");
lines.push("| --- | --- | --- | --- |");
for (const report of reports) {
  lines.push(
    `| \`${report.name}\` | ${report.androidLiveReport ? `\`${path.basename(report.androidLiveReport)}\`` : "-"} | ${
      report.androidNoArmReport ? `\`${path.basename(report.androidNoArmReport)}\`` : "-"
    } | ${report.androidAutoVideoReport ? `\`${path.basename(report.androidAutoVideoReport)}\`` : "-"
    } |`,
  );
}
lines.push("");
fs.writeFileSync(indexMd, `${lines.join("\n")}\n`);

console.log(
  JSON.stringify(
    {
      ok: true,
      reportDir,
      indexJson,
      indexMd,
      counts: summary.counts,
      latestReal: latestReal
        ? {
            file: latestReal.file,
            ok: latestReal.ok,
            failure: latestReal.failure,
          }
        : null,
      warnings: summary.warnings,
    },
    null,
    2,
  ),
);
