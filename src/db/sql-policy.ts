import sqlParser from 'node-sql-parser';

const { Parser } = sqlParser;
const parser = new Parser();

export class SqlPolicyError extends Error {
  readonly code = 'MYSQL_SQL_NOT_READ_ONLY';

  constructor() {
    super('Only one read-only SQL statement is allowed.');
    this.name = 'SqlPolicyError';
  }
}

export class DmlPolicyError extends Error {
  readonly code = 'MYSQL_SQL_NOT_DML';

  constructor() {
    super('Only one top-level DML statement is allowed.');
    this.name = 'DmlPolicyError';
  }
}

type AstNode = Readonly<Record<string, unknown>>;

function isAstNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasSafeSelectOutput(select: AstNode): boolean {
  const into = select.into;

  return (
    (into === null || (isAstNode(into) && into.position === null && into.keyword === undefined && into.expr === undefined)) &&
    (select.locking_read === null || select.locking_read === undefined)
  );
}

function isUserVariableAssignment(node: AstNode): boolean {
  return node.type === 'assign' && isAstNode(node.left) && node.left.type === 'var' && node.left.prefix === '@';
}

function isStateChangingLockFunction(node: AstNode): boolean {
  if (node.type !== 'function' || !isAstNode(node.name) || !Array.isArray(node.name.name)) {
    return false;
  }

  const lastNamePart = node.name.name.at(-1);
  if (!isAstNode(lastNamePart) || typeof lastNamePart.value !== 'string') {
    return false;
  }

  return ['get_lock', 'release_lock', 'release_all_locks'].includes(lastNamePart.value.toLowerCase());
}

function containsUnsafeNestedStatement(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsUnsafeNestedStatement);
  }

  if (!isAstNode(value)) {
    return false;
  }

  if (isUserVariableAssignment(value) || isStateChangingLockFunction(value)) {
    return true;
  }

  if (
    value.type === 'insert' ||
    value.type === 'replace' ||
    value.type === 'update' ||
    value.type === 'delete' ||
    value.type === 'create' ||
    value.type === 'alter' ||
    value.type === 'drop' ||
    value.type === 'use'
  ) {
    return true;
  }

  if (value.type === 'select' && !hasSafeSelectOutput(value)) {
    return true;
  }

  return Object.values(value).some(containsUnsafeNestedStatement);
}

function isSafeSelect(select: AstNode): boolean {
  if (select.type !== 'select' || !hasSafeSelectOutput(select)) {
    return false;
  }

  const withClauses = select.with;
  if (withClauses !== null && withClauses !== undefined) {
    if (!Array.isArray(withClauses)) {
      return false;
    }

    const safeCtes = withClauses.every((clause) => {
      if (!isAstNode(clause) || !isAstNode(clause.stmt) || !isAstNode(clause.stmt.ast)) {
        return false;
      }

      return isSafeSelect(clause.stmt.ast);
    });

    if (!safeCtes) {
      return false;
    }
  }

  return !Object.entries(select)
    .filter(([key]) => key !== 'with')
    .some(([, value]) => containsUnsafeNestedStatement(value));
}

function isSafeStatement(statement: AstNode): boolean {
  if (isSafeSelect(statement)) {
    return true;
  }

  return statement.type === 'explain' && isAstNode(statement.expr) && isSafeSelect(statement.expr);
}

function parseStatement(sql: string): AstNode {
  if (typeof sql !== 'string' || sql.includes('/*!')) {
    throw new SqlPolicyError();
  }

  let ast: unknown;
  try {
    ast = parser.astify(sql, { database: 'MySQL' });
  } catch {
    throw new SqlPolicyError();
  }

  const statements = Array.isArray(ast) ? ast : [ast];
  const statement = statements[0];

  if (statements.length !== 1 || !isAstNode(statement)) {
    throw new SqlPolicyError();
  }

  return statement;
}

export function assertReadOnlySql(sql: string): void {
  if (!isSafeStatement(parseStatement(sql))) {
    throw new SqlPolicyError();
  }
}

export function assertDmlSql(sql: string): void {
  let statement: AstNode;
  try {
    statement = parseStatement(sql);
  } catch {
    throw new DmlPolicyError();
  }

  if (statement.type !== 'insert' && statement.type !== 'update' && statement.type !== 'delete') {
    throw new DmlPolicyError();
  }
}

function assertBoundedLimit(limit: unknown, maximumRows: number): void {
  if (!isAstNode(limit) || !Array.isArray(limit.value) || limit.value.length === 0) {
    throw new SqlPolicyError();
  }

  const values = limit.value;
  const separator = limit.seperator;
  const rowCount = separator === 'offset' ? values[0] : values.at(-1);
  if (
    !isAstNode(rowCount) ||
    rowCount.type !== 'number' ||
    typeof rowCount.value !== 'number' ||
    !Number.isSafeInteger(rowCount.value) ||
    rowCount.value < 0 ||
    rowCount.value > maximumRows
  ) {
    throw new SqlPolicyError();
  }
}

export function assertBoundedSelectSql(sql: string, maximumRows: number): void {
  if (!Number.isSafeInteger(maximumRows) || maximumRows < 1) {
    throw new TypeError('maximumRows must be a positive safe integer.');
  }

  const statement = parseStatement(sql);
  if (!isSafeSelect(statement)) {
    throw new SqlPolicyError();
  }

  try {
    assertBoundedLimit(statement.limit, maximumRows);
  } catch {
    throw new SqlPolicyError();
  }
}
