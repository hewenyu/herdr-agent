import { posix } from "node:path";
import ts from "typescript";

export interface ModuleDependency {
  specifier: string;
  typeOnly: boolean;
  line: number;
}

/** Parse syntax, not text: comments and string examples are not dependencies. */
export function moduleDependencies(path: string, text: string): ModuleDependency[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const dependencies: ModuleDependency[] = [];
  const add = (node: ts.Node, value: ts.Node | undefined, typeOnly: boolean) => {
    if (value && ts.isStringLiteralLike(value))
      dependencies.push({
        specifier: value.text,
        typeOnly,
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const typeOnly =
        clause?.isTypeOnly === true ||
        (!clause?.name &&
          !!bindings &&
          ts.isNamedImports(bindings) &&
          bindings.elements.length > 0 &&
          bindings.elements.every((element) => element.isTypeOnly));
      add(node, node.moduleSpecifier, typeOnly);
    } else if (ts.isExportDeclaration(node)) {
      const clause = node.exportClause;
      const typeOnly =
        node.isTypeOnly ||
        (!!clause &&
          ts.isNamedExports(clause) &&
          clause.elements.length > 0 &&
          clause.elements.every((element) => element.isTypeOnly));
      add(node, node.moduleSpecifier, typeOnly);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node, node.argument.literal, true);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node, node.moduleReference.expression, node.isTypeOnly);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument)) add(node, argument, false);
      else
        dependencies.push({
          specifier: "<computed>",
          typeOnly: false,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return dependencies;
}

/** Selected architectural invariants, not a claim that the whole graph is acyclic. */
export function boundaryViolation(path: string, dependency: ModuleDependency): string | undefined {
  const { specifier, typeOnly } = dependency;
  const target = specifier.startsWith(".")
    ? posix.normalize(posix.join(posix.dirname(path), specifier))
    : undefined;
  const layer = path.split("/")[1];
  const targetLayer = target?.startsWith("src/") ? target.split("/")[1] : undefined;
  const browser = path.startsWith("src/web/client/");
  if (browser) {
    if (target?.startsWith("src/web/client/")) return;
    if (typeOnly && (target === "src/web/contracts.js" || target === "src/core/types.js")) return;
    return "Browser code may use only client modules and type-only Web/core contracts";
  }
  if (path === "src/web/contracts.ts") {
    if (typeOnly && target === "src/core/types.js") return;
    return "Web contracts must remain type-only and independent of server implementations";
  }
  if (!target) return; // Server packages and Node builtins are not local layer dependencies.
  const allowed: Record<string, readonly string[]> = {
    core: ["core"],
    storage: ["storage", "core"],
    runtime: ["runtime", "core", "config", "storage"],
  };
  const layers = layer && allowed[layer];
  if (layers && (!targetLayer || !layers.includes(targetLayer)))
    return `${layer} may depend only on ${layers.join(", ")}`;
  if (
    (layer === "tasks" || layer === "orchestration") &&
    ["app", "cli", "web", "feishu", "onboarding"].includes(targetLayer ?? "")
  )
    return `${layer} must use domain contracts/ports, not application or transport implementations`;
}

export function checkModuleBoundaries(files: ReadonlyMap<string, string>): string[] {
  const violations: string[] = [];
  for (const [path, text] of files) {
    for (const dependency of moduleDependencies(path, text)) {
      const reason = boundaryViolation(path, dependency);
      if (reason) violations.push(`${path}:${dependency.line}: ${dependency.specifier}: ${reason}`);
    }
  }
  return violations.sort();
}
