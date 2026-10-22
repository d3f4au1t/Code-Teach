import ts from 'typescript';
import { CallExample, SourceLink, TeachingStep } from './model';

const text = (node: ts.Node, limit = 180) => node.getText().replace(/\s+/g, ' ').slice(0, limit);

/** Explain written statements without evaluating any project expression. */
export function teachingSteps(body: ts.Node, link: (node: ts.Node) => SourceLink): { steps: TeachingStep[]; truncated: boolean } {
  const statements = ts.isBlock(body) || ts.isSourceFile(body) ? [...body.statements] : [body];
  const steps = statements.slice(0, 12).map((node): TeachingStep => {
    let title = 'Expression', detail = 'Read this expression in the surrounding scope.', kind: TeachingStep['kind'] = 'compute';
    const declaration = ts.isVariableStatement(node) && node.declarationList.declarations.length === 1 ? node.declarationList.declarations[0] : ts.isVariableDeclaration(node) ? node : undefined;
    if (declaration) {
      title = `Calculate ${text(declaration.name, 60)}`;
      const initializer = declaration.initializer;
      detail = initializer ? `Store ${ts.isCallExpression(initializer) ? `the result of ${text(initializer)}` : text(initializer)} in ${text(declaration.name, 60)} so later code can use it.` : 'Declare a name. Its value has not been assigned here.';
      if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
        title = `Define ${text(declaration.name, 60)}`; kind = 'declaration'; detail = 'Create a function value. Defining it does not run its body.';
      }
    } else if (ts.isReturnStatement(node) || (ts.isExpression(node) && ts.isArrowFunction(node.parent) && node.parent.body === node)) {
      const expression = ts.isReturnStatement(node) ? node.expression : node;
      title = 'Return'; kind = 'return';
      detail = expression ? `Give ${ts.isCallExpression(expression) ? `the result of ${text(expression)}` : text(expression)} back to the caller.` : 'End this call without a value (undefined).';
    } else if (ts.isIfStatement(node)) {
      title = 'Condition'; kind = 'branch';
      detail = `When ${text(node.expression)} is true, take the first branch.${node.elseStatement ? ' Otherwise, take the else branch.' : ' Otherwise, continue after it.'} The chosen path depends on the inputs.`;
    } else if (ts.isSwitchStatement(node)) {
      title = 'Switch'; kind = 'branch'; detail = `Compare ${text(node.expression)} with the case labels. Execution can continue into the next case unless a break or return stops it.`;
    } else if (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) {
      title = 'Loop'; kind = 'loop'; detail = 'This loop can run its body repeatedly. The condition or collection decides how many times; do not treat it as one execution.';
    } else if (ts.isThrowStatement(node)) {
      title = 'Throw'; kind = 'effect'; detail = `Throw ${text(node.expression)}. The caller needs to catch the error, or it propagates outward.`;
    } else if (ts.isTryStatement(node)) {
      title = 'Error handling'; kind = 'branch'; detail = 'Try the main block. A catch handles thrown errors; a finally block runs when control leaves the try/catch.';
    } else if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
      title = 'Declaration'; kind = 'declaration'; detail = ts.isFunctionDeclaration(node)
        ? 'Define a function. This does not run its body; follow the function to inspect it.'
        : 'Define a class. Instance methods run when called; static fields and static blocks can run during class creation.';
    } else if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      title = 'Module link'; kind = 'declaration'; detail = 'This declaration connects names between files. Follow the import relationship to open its source.';
    } else if (ts.isExpressionStatement(node)) {
      title = 'Operation'; detail = `Evaluate ${text(node.expression)}. Its result is not explicitly returned by this statement; the operation may change state.`;
    }
    const code = node.getText();
    return { title, detail, kind, code: code.length > 600 ? `${code.slice(0, 600)}\n…` : code, source: link(node) };
  });
  return {steps, truncated:statements.length > 12};
}

export function callExamples(parameters: readonly ts.ParameterDeclaration[], calls: readonly (ts.CallExpression | ts.NewExpression)[], link: (node: ts.Node) => SourceLink): CallExample[] {
  // TypeScript's leading `this` parameter is type-only and consumes no argument.
  const inputs = parameters.filter(parameter => !(ts.isIdentifier(parameter.name) && parameter.name.text === 'this'));
  return calls.slice(0, 3).map(call => {
    const args = [...(call.arguments ?? [])];
    const spread = args.some(ts.isSpreadElement);
    return { code:text(call, 500), source:link(call),
      bindings:spread ? [] : inputs.slice(0, 12).map((parameter, index) => ({
        parameter:text(parameter.name, 90),
        argument:parameter.dotDotDotToken ? `[${args.slice(index).map(argument => text(argument, 90)).join(', ').slice(0, 300)}]`
          : args[index] ? text(args[index], 300) : parameter.initializer ? `omitted → default ${text(parameter.initializer, 120)}` : 'omitted → undefined',
      })),
      note:spread ? 'This call uses spread arguments; their runtime values and parameter mapping are unknown. Code is not executed.'
        : 'Arguments written at this call site, not executed values. Expressions may evaluate differently at runtime.' + (inputs.length > 12 ? ' Only the first 12 parameters are shown.' : ''),
    };
  });
}

/** Only give array-method hints when the receiver is declared as an array in indexed code. */
export function arrayMethodHint(call: ts.CallExpression, checker: ts.TypeChecker): { detail: string; mutates: boolean } | undefined {
  if (!ts.isPropertyAccessExpression(call.expression)) return undefined;
  const receiver = call.expression.expression;
  const declaration = checker.getSymbolAtLocation(receiver)?.valueDeclaration;
  const annotation = declaration && (declaration as ts.ParameterDeclaration).type;
  const initializer = declaration && (declaration as ts.VariableDeclaration).initializer;
  if (!ts.isArrayLiteralExpression(receiver) && !(annotation && ts.isArrayTypeNode(annotation)) && !(initializer && ts.isArrayLiteralExpression(initializer))) return undefined;
  const name = text(receiver, 60);
  const hints: Record<string, string> = {
    push: `add items to the end of ${name}`, pop: `remove the last item from ${name}`,
    shift: `remove the first item from ${name}`, unshift: `add items to the start of ${name}`,
    splice: `insert or remove items in ${name}`, sort: `reorder ${name}`, reverse: `reverse the order of ${name}`,
    fill: `replace items in ${name}`, copyWithin: `copy items within ${name}`,
  };
  const method = call.expression.name.text;
  if (hints[method]) return {detail:`Array pattern: ${hints[method]} and change that same array. This assumes the standard ${method} method.`,mutates:true};
  if (method === 'reduce') return {detail:`Array pattern: combine the items in ${name} into one value${call.arguments[1] ? `, starting with ${text(call.arguments[1],60)}` : ', starting with the first item (an empty array throws without an initial value)'}. The callback produces the next accumulated value. This assumes the standard reduce method.`,mutates:false};
  if (method === 'map') return {detail:`Array pattern: transform each item in ${name} to create a new array. The callback may have its own side effects. This assumes the standard map method.`,mutates:false};
  if (method === 'filter') return {detail:`Array pattern: create a new array containing items whose callback result is truthy. This assumes the standard filter method.`,mutates:false};
  return undefined;
}
