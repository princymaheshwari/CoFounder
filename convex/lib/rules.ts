import type { Department, Role, RuleScopeLevel, RuleStatus } from "./types";

type ScopedRule = {
  status: RuleStatus;
  scope: { level: RuleScopeLevel; department?: Department; role?: Role };
};

// Active rules that apply to a role: company-wide, its department, or the role itself.
// Used for the ASSIGN's rules_in_scope (spec 04) and `co data rules` (spec 06).
export function ruleInScope(rule: ScopedRule, role: Role, department: Department): boolean {
  if (rule.status !== "active") return false;
  const s = rule.scope;
  return (
    s.level === "company" ||
    (s.level === "department" && s.department === department) ||
    (s.level === "role" && s.role === role)
  );
}
