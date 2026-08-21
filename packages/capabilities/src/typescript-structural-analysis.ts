import * as posixPath from "node:path/posix";
import * as ts from "typescript";

import type {
  SourceRegion,
  StructuralFileAnalysis,
  StructuralLanguage,
  StructuralSymbolEvidence,
  WorkspaceInspectSymbolKind
} from "./contracts.js";

export interface AnalyzeTypeScriptSourceInput {
  path: string;
  contents: string;
}

export function analyzeTypeScriptSource(input: AnalyzeTypeScriptSourceInput): StructuralFileAnalysis {
  const language = languageForPath(input.path);
  const source = ts.createSourceFile(
    input.path,
    input.contents,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForPath(input.path)
  );
  const symbols: StructuralSymbolEvidence[] = [];

  const visit = (node: ts.Node): void => {
    const symbol = symbolForNode(source, input.path, node);
    if (symbol !== undefined) symbols.push(symbol);
    ts.forEachChild(node, visit);
  };
  visit(source);

  symbols.sort(compareSymbols);
  return {
    path: input.path,
    language,
    precision: "structural",
    symbols,
    references: [],
    relationships: [],
    warnings: []
  };
}

function symbolForNode(
  source: ts.SourceFile,
  path: string,
  node: ts.Node
): StructuralSymbolEvidence | undefined {
  if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
    return symbol(source, path, node.name.text, "function", node, isExported(node));
  }
  if (ts.isClassDeclaration(node) && node.name !== undefined) {
    return symbol(source, path, node.name.text, "class", node, isExported(node));
  }
  if (ts.isInterfaceDeclaration(node)) {
    return symbol(source, path, node.name.text, "interface", node, isExported(node));
  }
  if (ts.isTypeAliasDeclaration(node)) {
    return symbol(source, path, node.name.text, "type", node, isExported(node));
  }
  if (ts.isEnumDeclaration(node)) {
    return symbol(source, path, node.name.text, "enum", node, isExported(node));
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    const regionNode = variableStatementFor(node) ?? node;
    return symbol(
      source,
      path,
      node.name.text,
      "variable",
      regionNode,
      isExported(regionNode)
    );
  }
  return undefined;
}

function symbol(
  source: ts.SourceFile,
  path: string,
  name: string,
  kind: WorkspaceInspectSymbolKind,
  node: ts.Node,
  exported: boolean
): StructuralSymbolEvidence {
  const region = regionForNode(source, node);
  return {
    name,
    kind,
    path,
    line: region.startLine,
    exported,
    region
  };
}

function regionForNode(source: ts.SourceFile, node: ts.Node): SourceRegion {
  const start = source.getLineAndCharacterOfPosition(node.getStart(source));
  const endPosition = Math.max(node.getStart(source), node.end - 1);
  const end = source.getLineAndCharacterOfPosition(endPosition);
  return { startLine: start.line + 1, endLine: end.line + 1 };
}

function variableStatementFor(node: ts.VariableDeclaration): ts.VariableStatement | undefined {
  const list = node.parent;
  return ts.isVariableDeclarationList(list) && ts.isVariableStatement(list.parent) ? list.parent : undefined;
}

function isExported(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return (
    modifiers?.some(
      (modifier) =>
        modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword
    ) ?? false
  );
}

function languageForPath(path: string): StructuralLanguage {
  const extension = posixPath.extname(path).toLowerCase();
  return [".js", ".jsx", ".mjs", ".cjs"].includes(extension) ? "javascript" : "typescript";
}

function scriptKindForPath(path: string): ts.ScriptKind {
  switch (posixPath.extname(path).toLowerCase()) {
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".tsx":
      return ts.ScriptKind.TSX;
    default:
      return ts.ScriptKind.TS;
  }
}

function compareSymbols(left: StructuralSymbolEvidence, right: StructuralSymbolEvidence): number {
  return (
    compareText(left.path, right.path) ||
    left.line - right.line ||
    compareText(left.kind, right.kind) ||
    compareText(left.name, right.name)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
