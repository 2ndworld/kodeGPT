import * as posixPath from "node:path/posix";
import * as ts from "typescript";

import type {
  SourceRegion,
  StructuralFileAnalysis,
  StructuralLanguage,
  StructuralReferenceEvidence,
  StructuralRelationshipEvidence,
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
  const parseDiagnostics =
    (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  const symbols: StructuralSymbolEvidence[] = [];
  const references: StructuralReferenceEvidence[] = [];
  const relationships = new Map<string, StructuralRelationshipEvidence>();

  const visit = (node: ts.Node): void => {
    const symbol = symbolForNode(source, input.path, node);
    if (symbol !== undefined) symbols.push(symbol);

    if (ts.isIdentifier(node) && isReferenceIdentifier(node)) {
      references.push(referenceForIdentifier(source, input.path, node));
    }

    const relationship = moduleRelationship(input.path, node);
    if (relationship !== undefined) {
      relationships.set(`${relationship.from}\0${relationship.to}\0${relationship.kind}`, relationship);
    }

    ts.forEachChild(node, visit);
  };
  visit(source);

  symbols.sort(compareSymbols);
  references.sort(compareReferences);
  return {
    path: input.path,
    language,
    precision: parseDiagnostics.length === 0 ? "structural" : "heuristic",
    symbols,
    references,
    relationships: [...relationships.values()].sort(compareRelationships),
    warnings: parseDiagnostics.length === 0 ? [] : ["STRUCTURAL_PARSE_FAILED"]
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

function referenceForIdentifier(
  source: ts.SourceFile,
  path: string,
  node: ts.Identifier
): StructuralReferenceEvidence {
  const position = source.getLineAndCharacterOfPosition(node.getStart(source));
  const line = position.line + 1;
  return {
    name: node.text,
    path,
    line,
    column: position.character + 1,
    kind: "reference",
    region: { startLine: line, endLine: line }
  };
}

function isReferenceIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;

  if (
    (ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  if (
    (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  if (
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isExportSpecifier(parent)
  ) {
    return false;
  }
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isLabeledStatement(parent) && parent.label === node) return false;
  if ((ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node) return false;

  return true;
}

function moduleRelationship(path: string, node: ts.Node): StructuralRelationshipEvidence | undefined {
  const specifier =
    ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
      ? node.moduleSpecifier.text
      : ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : undefined;
  if (specifier === undefined || !specifier.startsWith(".")) return undefined;

  const target = posixPath.normalize(posixPath.join(posixPath.dirname(path), specifier));
  if (target === ".." || target.startsWith("../") || target.startsWith("/")) return undefined;
  return { from: path, to: target, kind: "imports", precision: "structural" };
}

function compareReferences(
  left: StructuralReferenceEvidence,
  right: StructuralReferenceEvidence
): number {
  return (
    compareText(left.path, right.path) ||
    left.line - right.line ||
    left.column - right.column ||
    compareText(left.name, right.name)
  );
}

function compareRelationships(
  left: StructuralRelationshipEvidence,
  right: StructuralRelationshipEvidence
): number {
  return compareText(left.from, right.from) || compareText(left.to, right.to) || compareText(left.kind, right.kind);
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
