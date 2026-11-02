import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DshAdapter } from "../../dist/src/live/dsh-adapter.js";
import { PERSONAS } from "../../dist/src/live/persona.js";
const root = path.resolve(process.argv[2] ?? ".local/live");
const cfg = JSON.parse(
  await fs.readFile(path.join(root, "config.json"), "utf8"),
).live;
// Credentials stay in this process and its own worker environment, never in CLI arguments or reports.
if (process.argv[3]) {
  const { loadSecret } = await import(path.resolve(process.argv[3]));
  process.env.CLAWSENSE_GLM_API_KEY = await loadSecret();
}
const adapter = new DshAdapter(cfg.dsh);
const sessionId = "live-dsh-" + randomUUID();
const artifactName = "live-followup-" + randomUUID() + ".md";
const report = {
  phoneUsed: false,
  routes: adapter.routes(),
  cancelSupported: adapter.cancelSupported,
  turns: [],
  failures: [],
};
try {
  for (const query of [
    "这是隔离验收，只使用本提示词的合成事实，不读取其他文件、不调用外部服务、不发送消息：小陈周四收到方案，预算三万元。请只回答截止时间和预算。",
    "继续刚才的话题，方案接收方是谁？请只回答姓名。",
    `这是获准的隔离验收任务：请使用文件写入工具，在当前工作目录创建 ${artifactName}，写入小陈周四收到方案、预算三万元。不读取外部资料、不发送消息、不修改当前工作目录以外的文件。创建后报告路径。`,
  ]) {
    let text = "";
    const start = performance.now();
    for await (const c of adapter.reply(
      {
        sessionId,
        query,
        history: [],
        context: { scene: [], confirmed: [], work: [] },
        persona: PERSONAS[0],
      },
      new AbortController().signal,
    ))
      if (c.type === "text") text += c.text;
    report.turns.push({ query, text, durationMs: performance.now() - start });
    console.log("turn", JSON.stringify(report.turns.at(-1)));
  }
  const file = path.join(cfg.dsh.cwd, artifactName);
  const body = await fs.readFile(file, "utf8");
  report.artifact = {
    file,
    containsFacts:
      body.includes("小陈") && body.includes("周四") && body.includes("三万"),
  };
  if (!report.artifact.containsFacts) throw new Error("artifact_facts_missing");
} catch (e) {
  report.failures.push(e.message);
  process.exitCode = 1;
  console.log("failed", e.message);
} finally {
  await adapter.close();
  await fs.writeFile(
    path.join(root, "dsh-report.json"),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
}
