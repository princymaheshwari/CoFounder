import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { extractEnvelopeBlock, parseEnvelope } from "../convex/lib/envelope";
import type { Role } from "../convex/lib/types";

// The Creao setup prompts (agents/creao/*.md) teach each agent its envelope by example. Every example must pass
// the same validator the Dispatcher runs, and every test input must be a well-formed ASSIGN for that role.

const DIR = join(__dirname, "..", "agents", "creao");
const files = readdirSync(DIR).filter((f) => f.endsWith(".md") && f !== "README.md");

const section = (md: string, heading: string) => md.slice(md.indexOf(heading));

describe("agents/creao prompts", () => {
  test("there is one prompt per role plus the Executor", () => {
    expect(files.sort()).toEqual(
      ["cofounder", "content", "customer_manager", "executor", "finance_manager", "ledger", "market_intel", "marketing_manager", "retention", "spend", "support"].map((r) => `${r}.md`),
    );
  });

  test.each(files)("%s: the example envelopes pass the validator", (file) => {
    const md = readFileSync(join(DIR, file), "utf8");
    const role = file.replace(/\.md$/, "") as Role;
    const examples = section(md, "## Example output");
    const blocks = [...examples.matchAll(/```cofounder\r?\n([\s\S]*?)```/g)].map((m) => m[1]);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      const env = JSON.parse(block) as { task: string };
      const parsed = parseEnvelope("Done.\n\n```cofounder\n" + block + "```", { taskId: env.task, role, ...(role === "cofounder" ? { kind: "package" as const } : {}) });
      expect(parsed, block).toMatchObject({ ok: true });
    }
  });

  test.each(files.filter((f) => f !== "executor.md"))("%s: the test input is an ASSIGN for that role", (file) => {
    const md = readFileSync(join(DIR, file), "utf8");
    const role = file.replace(/\.md$/, "");
    const test = md.slice(md.indexOf("**Test input"), md.indexOf("---- PASTE BELOW THIS LINE INTO CREAO ----"));
    const block = extractEnvelopeBlock(test.replace(/^````text\r?\n|````\s*$/gm, ""));
    expect(block).not.toBeNull();
    expect(JSON.parse(block!)).toMatchObject({ type: "ASSIGN", to: role, token: expect.any(String), rules_in_scope: expect.any(Array) });
    expect(md).toContain("---- PASTE BELOW THIS LINE INTO CREAO ----");
  });

  test("no prompt names the demo company or its price", () => {
    for (const file of files) expect(readFileSync(join(DIR, file), "utf8")).not.toMatch(/lumen|\$35\b|meeting notes/i);
  });
});
