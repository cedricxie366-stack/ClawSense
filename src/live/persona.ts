import fs from "node:fs/promises";
import { lstatSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PersonaProfile } from "./types.js";
const base = {
  version: 1 as const,
  background: "喜欢一起把事情做好的一位AI搭子",
  catchphrases: [],
  voice: "Vivian",
  style: "自然、清楚、温和",
  participation: "addressed" as const,
  cooldownMs: 180000,
  publicScene: false,
};
export const PERSONAS: PersonaProfile[] = [
  {
    ...base,
    id: "gentle",
    name: "小伴",
    expression: "温和体贴，认真倾听，不说教",
  },
  {
    ...base,
    id: "focused",
    name: "小策",
    expression: "干练直接，先说结论与下一步",
    style: "平静、清楚、干练",
    catchphrases: ["咱们一步步来"],
  },
  {
    ...base,
    id: "playful",
    name: "小乐",
    expression: "轻松幽默，适度打趣，严肃话题保持认真",
    style: "轻松、活泼、自然",
    catchphrases: ["这事儿有点意思"],
  },
];
export function validatePersona(value: unknown): PersonaProfile {
  if (!value || typeof value !== "object") throw new Error("invalid_persona");
  const p = value as PersonaProfile;
  const limit = (s: unknown, n: number) =>
    typeof s === "string" && s.length <= n;
  if (
    p.version !== 1 ||
    !/^[a-z0-9_-]{1,64}$/i.test(p.id) ||
    !p.name?.trim() ||
    !limit(p.name, 80) ||
    !limit(p.background, 2000) ||
    !limit(p.expression, 2000) ||
    !limit(p.voice, 80) ||
    !limit(p.style, 500) ||
    !["quiet", "addressed", "active"].includes(p.participation) ||
    !Number.isInteger(p.cooldownMs) ||
    p.cooldownMs < 30000 ||
    p.cooldownMs > 3600000 ||
    typeof p.publicScene !== "boolean" ||
    !Array.isArray(p.catchphrases) ||
    p.catchphrases.length > 8 ||
    !p.catchphrases.every((s) => limit(s, 80))
  )
    throw new Error("invalid_persona");
  return {
    version: 1,
    id: p.id,
    name: p.name,
    background: p.background,
    expression: p.expression,
    voice: p.voice,
    style: p.style,
    catchphrases: [...p.catchphrases],
    participation: p.participation,
    cooldownMs: p.cooldownMs,
    publicScene: p.publicScene,
  };
}
export class PersonaStore {
  constructor(private root: string) {}
  private file(device: string) {
    if (!/^[a-z0-9_-]{1,100}$/i.test(device))
      throw new Error("invalid_device_id");
    return path.join(this.root, "live", "personas", device + ".json");
  }
  revision(device: string): string {
    try {
      const stat = lstatSync(this.file(device));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error("invalid_persona_file");
      return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
  }
  async read(device: string): Promise<PersonaProfile> {
    try {
      return validatePersona(
        JSON.parse(await fs.readFile(this.file(device), "utf8")),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        return structuredClone(PERSONAS[0]!);
      throw e;
    }
  }
  async write(device: string, data: unknown): Promise<PersonaProfile> {
    const p = validatePersona(data),
      file = this.file(device),
      tmp = file + "." + randomUUID();
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      await fs.writeFile(tmp, JSON.stringify(p, null, 2), {
        mode: 0o600,
        flag: "wx",
      });
      await fs.rename(tmp, file);
    } finally {
      await fs.rm(tmp, { force: true });
    }
    return p;
  }
}
