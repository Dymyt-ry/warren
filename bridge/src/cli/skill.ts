// `warren skill`: teach this machine's coding agents how to open Warren rooms
// and share join links (Claude Code reads ~/.claude/skills, Codex ~/.agents/skills).
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The skill shipped with this package (dist/cli/skill.js → ../../skills/warren/SKILL.md). */
export function bundledSkill(): string {
  return fileURLToPath(new URL("../../skills/warren/SKILL.md", import.meta.url));
}

export function installSkill(home = homedir(), source = bundledSkill()): string[] {
  const text = readFileSync(source, "utf8");
  const lines: string[] = [];
  for (const [agent, root] of [
    ["Claude Code", join(home, ".claude", "skills")],
    ["Codex", join(home, ".agents", "skills")],
  ] as const) {
    const target = join(root, "warren", "SKILL.md");
    const folder = dirname(target);
    if (existsSync(folder) && lstatSync(folder).isSymbolicLink()) {
      lines.push(`${agent}: ${folder} is a link you manage; left as is`);
      continue;
    }
    mkdirSync(folder, { recursive: true });
    const before = existsSync(target) ? readFileSync(target, "utf8") : undefined;
    writeFileSync(target, text);
    lines.push(`${agent}: ${before === undefined ? "installed" : before === text ? "up to date" : "updated"} ${target}`);
  }
  return lines;
}
