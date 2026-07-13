export type RuleExpr =
  | { kind: "role"; role: string }
  | { kind: "owner"; field: string }
  | { kind: "authenticated" }
  | { kind: "public" }
  | { kind: "or"; rules: RuleExpr[] }
  | { kind: "and"; rules: RuleExpr[] };

export class Rule {
  constructor(readonly expr: RuleExpr) {}

  or(other: Rule): Rule {
    // Flatten nested or combinators.
    const rules: RuleExpr[] = [];
    if (this.expr.kind === "or") {
      rules.push(...this.expr.rules);
    } else {
      rules.push(this.expr);
    }
    if (other.expr.kind === "or") {
      rules.push(...other.expr.rules);
    } else {
      rules.push(other.expr);
    }
    return new Rule({ kind: "or", rules });
  }

  and(other: Rule): Rule {
    // Flatten nested and combinators.
    const rules: RuleExpr[] = [];
    if (this.expr.kind === "and") {
      rules.push(...this.expr.rules);
    } else {
      rules.push(this.expr);
    }
    if (other.expr.kind === "and") {
      rules.push(...other.expr.rules);
    } else {
      rules.push(other.expr);
    }
    return new Rule({ kind: "and", rules });
  }
}

export const role = (name: string): Rule => {
  return new Rule({ kind: "role", role: name });
};

export const rule = {
  owner: (field: string): Rule => {
    return new Rule({ kind: "owner", field });
  },
  authenticated: (): Rule => {
    return new Rule({ kind: "authenticated" });
  },
  public: (): Rule => {
    return new Rule({ kind: "public" });
  },
};
