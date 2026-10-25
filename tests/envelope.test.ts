import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import completed from "../convex/creao/__fixtures__/get-run-completed.json";
import {
  companyBlock,
  extractEnvelopeBlock,
  formatAssign,
  formatDecision,
  formatDigest,
  formatHandoffAssign,
  formatNudge,
  formatRepair,
  parseEnvelope,
  type AssignArgs,
} from "../convex/lib/envelope";
import { replyText, parseRun } from "../convex/creao/runs";

const T = { taskId: "t_812", role: "support" as const };
const wrap = (env: unknown, prose = "Human line.") => `${prose}\n\n\`\`\`cofounder\n${JSON.stringify(env)}\n\`\`\``;
const base = { task: "t_812", from: "support", summary: "Did the thing." };
const refund = { type: "refund", params: { customer_id: "c_17", amount_cents: 3500, reason: "billing_error" }, rationale: "R7" };

function expectOk(text: string, expected: Parameters<typeof parseEnvelope>[1] = T) {
  const r = parseEnvelope(text, expected);
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.env;
}
function expectError(text: string, expected: Parameters<typeof parseEnvelope>[1] = T) {
  const r = parseEnvelope(text, expected);
  if (r.ok) throw new Error("expected an error");
  return r.error;
}
// One sentence: ends with a period and has no sentence break inside.
const isOneSentence = (s: string) => /\.$/.test(s) && !/[.!?]\s+[A-Z]/.test(s.slice(0, -1));

describe("parseEnvelope accepts every type", () => {
  test.each([
    ["REPORT", { ...base, type: "REPORT", findings: [{ claim: "c", evidence: "tk_9" }], proposed_actions: [refund] }, T],
    ["HANDOFF", { ...base, type: "HANDOFF", to_role: "ledger", brief: "Check the charges." }, T],
    ["ISSUE", { ...base, type: "ISSUE", kind: "coordination", attempts: ["refunded tk_9"] }, T],
    ["OBJECT", { ...base, type: "OBJECT", findings: [{ claim: "c", evidence: "#finance/12" }], refs: ["#leadership/310"] }, T],
    ["ESCALATE", { ...base, type: "ESCALATE", need: "authority", attempts: ["checked R7"], proposed_actions: [refund] }, T],
    [
      "DECISION",
      { type: "DECISION", task: "t_9", from: "customer_manager", summary: "Grouped.", proposed_actions: [refund] },
      { taskId: "t_9", role: "customer_manager" as const },
    ],
    [
      "REPORT with package",
      {
        type: "REPORT",
        task: "t_p",
        from: "cofounder",
        summary: "Package.",
        package: {
          situation: "12 duplicate charges",
          evidence: ["#finance/40"],
          attempts: ["Ledger matched charges"],
          options: [{ label: "Approve batch", action: { type: "refund_batch" } }, { label: "Deny" }],
          recommendation: "Approve batch",
        },
      },
      { taskId: "t_p", role: "cofounder" as const, kind: "package" as const },
    ],
  ] as const)("%s", (_name, env, expected) => {
    expect(expectOk(wrap(env), expected).type).toBe((env as { type: string }).type);
  });

  test("the real Support reply from spec 02 parses (chatText)", () => {
    const run = parseRun(completed);
    const env = expectOk(replyText(run), { taskId: "t_verify_1792895078195", role: "support" });
    expect(env).toMatchObject({ type: "REPORT", findings: [{ claim: "transport ok", evidence: "test" }] });
  });

  test("keeps extra action params and ignores unknown top-level fields", () => {
    const env = expectOk(
      wrap({ ...base, type: "REPORT", payload: { x: 1 }, proposed_actions: [{ ...refund, params: { ...refund.params, note: "hi" } }] }),
    );
    expect(env).not.toHaveProperty("payload");
    expect(env.proposed_actions?.[0].params).toMatchObject({ note: "hi" });
  });

  test("drops proposed_actions on types that do not carry actions", () => {
    const env = expectOk(wrap({ ...base, type: "ISSUE", kind: "information", attempts: ["a"], proposed_actions: [refund] }));
    expect(env.proposed_actions).toBeUndefined();
  });

  test("a REPORT may also carry an issue (spec 09); other types drop it", () => {
    const issue = { kind: "coordination", summary: "Same double charge in 6 tickets.", attempts: ["co data tickets"] };
    expect(expectOk(wrap({ ...base, type: "REPORT", proposed_actions: [refund], issue })).issue).toEqual(issue);
    expect(expectOk(wrap({ ...base, type: "ISSUE", kind: "coordination", attempts: ["a"], issue })).issue).toBeUndefined();
    expect(expectError(wrap({ ...base, type: "REPORT", issue: { ...issue, kind: "billing" } }))).toBe(
      'Field "issue.kind" must be one of: information, coordination, authority, capability.',
    );
    expect(expectError(wrap({ ...base, type: "REPORT", issue: { ...issue, attempts: [] } }))).toBe('Field "issue.attempts" needs at least 1 item(s).');
  });
});

describe("parseEnvelope rejects", () => {
  const actions = (n: number) => Array.from({ length: n }, () => refund);
  test.each([
    ["no block", "Just prose, no envelope.", /No envelope found/],
    ["a non-cofounder block only", "```json\n{\"type\":\"REPORT\"}\n```", /No envelope found/],
    ["invalid JSON", "```cofounder\n{type: REPORT}\n```", /not valid JSON/],
    ["a JSON array", "```cofounder\n[1]\n```", /JSON object/],
    ["wrong task", wrap({ ...base, task: "t_9", type: "REPORT" }), /Field "task" must be "t_812"/],
    ["wrong from", wrap({ ...base, from: "ledger", type: "REPORT" }), /Field "from" must be "support"/],
    ["missing summary", wrap({ type: "REPORT", task: "t_812", from: "support" }), /Field "summary" is required/],
    ["summary over 500 chars", wrap({ ...base, summary: "x".repeat(501), type: "REPORT" }), /Field "summary" must be at most 500/],
    ["unknown type", wrap({ ...base, type: "FYI" }), /Field "type" must be one of/],
    ["ASSIGN from an agent", wrap({ ...base, type: "ASSIGN" }), /cannot be ASSIGN/],
    ["HANDOFF without to_role", wrap({ ...base, type: "HANDOFF", brief: "b" }), /Field "to_role" is required for HANDOFF/],
    ["HANDOFF without brief", wrap({ ...base, type: "HANDOFF", to_role: "ledger" }), /Field "brief" is required for HANDOFF/],
    ["ISSUE without kind", wrap({ ...base, type: "ISSUE", attempts: ["a"] }), /Field "kind" is required for ISSUE/],
    ["ISSUE without attempts", wrap({ ...base, type: "ISSUE", kind: "information", attempts: [] }), /Field "attempts" needs at least one/],
    // Seen live 2026-10-25: Support sent attempts as a string.
    ["attempts as a string", wrap({ ...base, type: "ISSUE", kind: "information", attempts: "ran co" }), /^Field "attempts" must be an array\.$/],
    ["ESCALATE without need", wrap({ ...base, type: "ESCALATE", attempts: ["a"] }), /Field "need" is required for ESCALATE/],
    ["OBJECT without findings", wrap({ ...base, type: "OBJECT", refs: ["#x/1"] }), /Field "findings" needs at least one/],
    ["OBJECT without refs", wrap({ ...base, type: "OBJECT", findings: [{ claim: "c", evidence: "e" }] }), /Field "refs" must reference/],
    ["DECISION from an employee", wrap({ ...base, type: "DECISION" }), /cannot be DECISION for role "support"/],
    ["unknown action type", wrap({ ...base, type: "REPORT", proposed_actions: [{ ...refund, type: "buy_ads" }] }), /Field "proposed_actions\[0\]\.type" must be one of/],
    ["more than 5 actions", wrap({ ...base, type: "REPORT", proposed_actions: actions(6) }), /Field "proposed_actions" has too many items \(at most 5\)/],
    [
      "a negative amount",
      wrap({ ...base, type: "REPORT", proposed_actions: [{ ...refund, params: { ...refund.params, amount_cents: -3500 } }] }),
      /Field "proposed_actions\[0\]\.params\.amount_cents" must be a non-negative integer number of cents/,
    ],
    [
      "a fractional amount",
      wrap({ ...base, type: "REPORT", proposed_actions: [{ ...refund, params: { ...refund.params, amount_cents: 35.5 } }] }),
      /amount_cents" must be a non-negative integer/,
    ],
    [
      "a negative batch item",
      wrap({
        ...base,
        type: "ESCALATE",
        need: "authority",
        attempts: ["a"],
        proposed_actions: [{ type: "refund_batch", params: { items: [{ customer_id: "c_1", amount_cents: -1 }], reason: "dup" }, rationale: "r" }],
      }),
      /Field "proposed_actions\[0\]\.params\.items\[0\]\.amount_cents" must be a non-negative integer/,
    ],
    [
      "a missing action param",
      wrap({ ...base, type: "REPORT", proposed_actions: [{ type: "file_bug", params: { title: "t", body: "b" }, rationale: "r" }] }),
      /Field "proposed_actions\[0\]\.params\.severity" is required/,
    ],
  ] as const)("%s", (_name, text, pattern) => {
    const error = expectError(text);
    expect(error).toMatch(pattern);
    expect(isOneSentence(error)).toBe(true);
  });

  test("a REPORT on a package task without package", () => {
    const error = expectError(wrap({ type: "REPORT", task: "t_p", from: "cofounder", summary: "s" }), {
      taskId: "t_p",
      role: "cofounder",
      kind: "package",
    });
    expect(error).toBe('Field "package" is required in a REPORT on a package task.');
  });
});

describe("block selection", () => {
  test("picks the last cofounder block and ignores other code blocks", () => {
    const first = wrap({ ...base, type: "ISSUE", kind: "information", attempts: ["draft"] });
    const last = wrap({ ...base, type: "REPORT", summary: "final" });
    const text = `${first}\n\n${last}\n\n\`\`\`json\n{"type":"ESCALATE"}\n\`\`\``;
    expect(expectOk(text)).toMatchObject({ type: "REPORT", summary: "final" });
  });

  test("handles CRLF and a padded info string", () => {
    expect(extractEnvelopeBlock('x\r\n```  cofounder \r\n{"a":1}\r\n```')).toContain('{"a":1}');
  });
});

describe("Dispatcher formatters", () => {
  const company = companyBlock({
    name: "Lumen Notes",
    product: "AI meeting notes",
    plans: [{ name: "Pro", price_cents: 3500, period: "month" }],
    voice: "warm, concise",
    policies: ["refunds within 30 days for billing errors"],
  });
  const assign: AssignArgs = {
    mention: "Support",
    taskId: "t_812",
    role: "support",
    brief: "Customer c_17 asks for a $35 refund (ticket tk_9). Use ```code``` carefully.",
    token: "tok",
    company,
    rules: ["R7: allow refunds ≤ $40 for billing_error/defect when tenure ≥ 90 days"],
    dataHints: ["co data ticket tk_9", "co data customer c_17"],
    refs: [],
  };
  const blockOf = (text: string) => JSON.parse(extractEnvelopeBlock(text)!) as Record<string, unknown>;

  test("formatAssign starts with [Dispatcher] @Name and carries every ASSIGN field", () => {
    const text = formatAssign(assign);
    expect(text.startsWith("[Dispatcher] @Support New task t_812: ")).toBe(true);
    expect(blockOf(text)).toEqual({
      type: "ASSIGN",
      task: "t_812",
      to: "support",
      company,
      brief: assign.brief,
      token: "tok",
      rules_in_scope: assign.rules,
      data_hints: assign.dataHints,
      reply: "End your reply with exactly one cofounder envelope: a fenced block whose info string is cofounder, written out in full in this reply. Never describe or summarize an envelope instead of writing it. Never address other agents directly.",
      refs: [],
    });
  });

  test("backticks inside strings cannot close the fence", () => {
    const text = formatAssign(assign);
    expect(text.match(/```/g)).toHaveLength(2);
    expect(blockOf(text).brief).toBe(assign.brief);
  });

  test("formatRepair is a full ASSIGN with attempt and repair", () => {
    const text = formatRepair({ ...assign, attempt: 2, error: 'Field "kind" is required for ISSUE.' });
    expect(text.startsWith("[Dispatcher] @Support Repair on task t_812 (attempt 2)")).toBe(true);
    expect(blockOf(text)).toMatchObject({
      type: "ASSIGN",
      task: "t_812",
      to: "support",
      token: "tok",
      attempt: 2,
      repair: 'Field "kind" is required for ISSUE.',
    });
  });

  test("formatNudge is a full ASSIGN with attempt and nudge", () => {
    const text = formatNudge({ ...assign, attempt: 2, note: "No reply arrived before the deadline." });
    expect(text.startsWith("[Dispatcher] @Support Reminder on task t_812 (attempt 2): No reply arrived")).toBe(true);
    expect(blockOf(text)).toMatchObject({ type: "ASSIGN", task: "t_812", to: "support", attempt: 2, nudge: "No reply arrived before the deadline." });
  });

  test("formatHandoffAssign quotes the source and refs its thread", () => {
    const text = formatHandoffAssign({
      ...assign,
      mention: "Ledger",
      role: "ledger",
      taskId: "t_900",
      fromName: "Customer Manager",
      sourceRef: "#customer/1043",
      sourceSummary: "Six tickets report a double charge.",
    });
    const block = blockOf(text);
    expect(block.refs).toEqual(["#customer/1043"]);
    expect(block.brief).toContain('Handoff from Customer Manager (#customer/1043): "Six tickets report a double charge."');
  });

  test("formatDecision and formatDigest", () => {
    expect(blockOf(formatDecision({ taskId: "t_812", decidedBy: "founder", choice: "approve", note: "Refund all 12." }))).toEqual({
      type: "DECISION",
      task: "t_812",
      decided_by: "founder",
      choice: "approve",
      note: "Refund all 12.",
    });
    const digest = formatDigest("#customer", ["R7: …"]);
    expect(digest.startsWith("[Dispatcher] Rules digest for #customer: 1 active rule.")).toBe(true);
    expect(blockOf(digest)).toEqual({ type: "DIGEST", room: "#customer", rules: ["R7: …"] });
  });

  test("companyBlock stays within 1,500 chars", () => {
    const big = companyBlock({
      name: "Lumen Notes",
      product: "AI meeting notes",
      description: "long ".repeat(500),
      plans: [{ name: "Pro", price_cents: 3500, period: "month" }],
      policies: Array.from({ length: 40 }, (_, i) => `policy ${i}: ${"detail ".repeat(10)}`),
    });
    expect(JSON.stringify(big).length).toBeLessThanOrEqual(1500);
    expect(big).not.toHaveProperty("description");
  });
});

describe("agent prompts use the protocol's field names", () => {
  // Each role's prompt lists only the envelope types it sends; these fields every role needs.
  const envelopeFields = ["type", "task", "from", "summary", "findings", "claim", "evidence", "refs", "kind", "issue"];
  const assignFields = ["task", "to", "company", "brief", "token", "rules_in_scope", "data_hints", "refs", "repair", "attempt"];
  const kinds = ["information", "coordination", "authority", "capability"];

  const pasted = (role: string) => {
    const text = readFileSync(`agents/creao/${role}.md`, "utf8");
    return text.slice(text.indexOf("---- PASTE BELOW THIS LINE INTO CREAO ----"));
  };
  const roleFiles = ["support", "ledger", "customer_manager", "finance_manager", "cofounder", "retention", "spend", "marketing_manager", "market_intel", "content"];

  test.each(roleFiles.map((f) => [`agents/creao/${f}.md`, pasted(f)]))("%s", (_name, text) => {
    for (const word of [...envelopeFields, ...assignFields, ...kinds, "REPORT", "ISSUE"]) {
      expect(text, `missing "${word}"`).toContain(word);
    }
  });

  test("the Cofounder prompt names every package field", () => {
    const cofounder = pasted("cofounder");
    for (const word of ["package", "situation", "evidence", "attempts", "options", "label", "action", "recommendation"]) {
      expect(cofounder, `missing "${word}"`).toContain(word);
    }
  });
});
