import assert from 'node:assert/strict';
import ts from 'typescript';

/** Reads the migrated root contract without evaluating application code. */
export function readServiceRootExtras(sourceText: string, fileName: string, helperImport: string) {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const factories = new Set<string>();
  const constants = new Map<string, ts.Expression>();
  const rootBindings = new Set<string>();
  const extraBindings = new Set<string>();
  let exported: ts.Expression | undefined;

  function check(condition: unknown, message: string): asserts condition {
    assert.ok(condition, `${fileName}: ${message}`);
  }

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      const bindings = clause?.namedBindings;
      if (
        statement.moduleSpecifier.text === helperImport &&
        !clause?.isTypeOnly &&
        bindings &&
        ts.isNamedImports(bindings)
      ) {
        for (const binding of bindings.elements) {
          if (
            !binding.isTypeOnly &&
            (binding.propertyName?.text ?? binding.name.text) === 'defineService'
          ) {
            factories.add(binding.name.text);
          }
        }
      }
    }
    if (ts.isExportAssignment(statement)) {
      check(!statement.isExportEquals && !exported, 'Use one default export for the initializer');
      exported = statement.expression;
    } else if (ts.isExportDeclaration(statement)) {
      check(
        statement.isTypeOnly ||
          (statement.exportClause &&
            ts.isNamedExports(statement.exportClause) &&
            statement.exportClause.elements.every((element) => element.isTypeOnly)),
        'Named runtime exports belong in extras; type-only exports are allowed',
      );
    } else if (
      ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      check(
        ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement),
        'Named runtime exports belong in extras; type-only exports are allowed',
      );
    }
    if (
      ts.isVariableStatement(statement) &&
      (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
    ) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          constants.set(declaration.name.text, declaration.initializer);
        }
      }
    }
  }

  function unwrap(expression: ts.Expression): ts.Expression {
    while (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isNonNullExpression(expression)
    ) {
      expression = expression.expression;
    }
    return expression;
  }

  function resolve(
    expression: ts.Expression,
    bindings?: Set<string>,
    seen = new Set<string>(),
  ): ts.Expression {
    expression = unwrap(expression);
    if (!ts.isIdentifier(expression)) {
      return expression;
    }
    const value = constants.get(expression.text);
    check(
      value && !seen.has(expression.text),
      'Initializer and extras aliases must resolve to local const declarations',
    );
    seen.add(expression.text);
    bindings?.add(expression.text);
    return resolve(value, bindings, seen);
  }

  check(exported, 'Export a default defineService initializer');
  const initializer = resolve(exported, rootBindings);
  check(
    ts.isCallExpression(initializer) &&
      ts.isIdentifier(initializer.expression) &&
      factories.has(initializer.expression.text),
    'The default export must be created by the kernel defineService helper',
  );
  check(
    initializer.arguments.length === 2 || initializer.arguments.length === 3,
    'Use defineService(name, create, extras?)',
  );

  const extraArgument = initializer.arguments[2];
  const extraObject = extraArgument ? resolve(extraArgument, extraBindings) : undefined;

  // Prevent additions/overrides after construction, including through local aliases.
  for (const bindings of [rootBindings, extraBindings]) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const [name, expression] of constants) {
        const reference = unwrap(expression);
        if (ts.isIdentifier(reference) && bindings.has(reference.text) && !bindings.has(name)) {
          bindings.add(name);
          changed = true;
        }
      }
    }
  }
  function referencesRoot(expression: ts.Expression): boolean {
    expression = unwrap(expression);
    if (
      ts.isPropertyAccessExpression(expression) &&
      expression.name.text === 'extras' &&
      referencesRoot(expression.expression)
    ) {
      return true;
    }
    return (
      (ts.isIdentifier(expression) &&
        (rootBindings.has(expression.text) ||
          extraBindings.has(expression.text) ||
          expression.text === 'exports')) ||
      ((ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
        ts.isIdentifier(expression.expression) &&
        expression.expression.text === 'module' &&
        (ts.isPropertyAccessExpression(expression)
          ? expression.name.text === 'exports'
          : ts.isStringLiteral(expression.argumentExpression) &&
            expression.argumentExpression.text === 'exports'))
    );
  }
  function rootMember(expression: ts.Expression): boolean {
    expression = unwrap(expression);
    return (
      (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) &&
      referencesRoot(expression.expression)
    );
  }
  function inspect(node: ts.Node) {
    if (ts.isCallExpression(node)) {
      check(
        node === initializer || !node.arguments.some(referencesRoot),
        'Do not pass the initializer or extras to another function; declare helpers through extras',
      );
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      check(
        !rootMember(node.left) && !referencesRoot(node.left),
        'Do not add or override initializer properties or CommonJS exports',
      );
    } else if (ts.isDeleteExpression(node)) {
      check(!rootMember(node.expression), 'Do not mutate initializer properties');
    } else if (
      ts.isPostfixUnaryExpression(node) ||
      (ts.isPrefixUnaryExpression(node) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken ||
          node.operator === ts.SyntaxKind.MinusMinusToken))
    ) {
      check(!rootMember(node.operand), 'Do not mutate initializer properties');
    }
    ts.forEachChild(node, inspect);
  }
  inspect(source);

  if (initializer.arguments.length === 2) {
    return [];
  }
  check(extraObject, 'Supply the extras object as the third argument');
  const extras = extraObject;
  check(
    ts.isObjectLiteralExpression(extras),
    'Extras must be an explicit object so every member can be catalogued',
  );
  const names: string[] = [];
  for (const property of extras.properties) {
    check(
      ts.isShorthandPropertyAssignment(property) ||
        ts.isPropertyAssignment(property) ||
        ts.isMethodDeclaration(property),
      'List extras explicitly; no spreads or accessors',
    );
    check(
      ts.isIdentifier(property.name) || ts.isStringLiteral(property.name),
      'Give each extra a static name',
    );
    if (ts.isPropertyAssignment(property)) {
      const value = unwrap(property.initializer);
      check(
        ts.isIdentifier(value) ||
          ts.isPropertyAccessExpression(value) ||
          ts.isElementAccessExpression(value) ||
          ts.isArrowFunction(value) ||
          ts.isFunctionExpression(value) ||
          ts.isLiteralExpression(value) ||
          value.kind === ts.SyntaxKind.TrueKeyword ||
          value.kind === ts.SyntaxKind.FalseKeyword ||
          value.kind === ts.SyntaxKind.NullKeyword,
        'Pass helper references instead of invoking or constructing extras on import',
      );
    }
    check(!names.includes(property.name.text), 'List each extra once');
    names.push(property.name.text);
  }
  return names.sort();
}
