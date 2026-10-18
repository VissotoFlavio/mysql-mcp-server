import sqlParser, { type Select } from 'node-sql-parser';

const { Parser } = sqlParser;
const parser = new Parser();

export class SqlPolicyError extends Error {
  readonly code = 'MYSQL_SQL_NOT_READ_ONLY';

  constructor() {
    super('Only one read-only SQL statement is allowed.');
    this.name = 'SqlPolicyError';
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

function boundedLimit(limit: unknown, maximumRows: number): AstNode {
  if (limit === null || limit === undefined) {
    return { seperator: '', value: [{ type: 'number', value: maximumRows }] };
  }

  if (!isAstNode(limit) || !Array.isArray(limit.value) || limit.value.length === 0) {
    throw new SqlPolicyError();
  }

  const values = limit.value;
  const rowCount = values.at(-1);
  if (!isAstNode(rowCount) || rowCount.type !== 'number' || typeof rowCount.value !== 'number' || !Number.isSafeInteger(rowCount.value)) {
    throw new SqlPolicyError();
  }

  return {
    ...limit,
    value: [...values.slice(0, -1), { ...rowCount, value: Math.min(rowCount.value, maximumRows) }],
  };
}

export function prepareBoundedSelectSql(sql: string, maximumRows: number): string {
  if (!Number.isSafeInteger(maximumRows) || maximumRows < 1) {
    throw new TypeError('maximumRows must be a positive safe integer.');
  }

  const statement = parseStatement(sql);
  if (!isSafeSelect(statement)) {
    throw new SqlPolicyError();
  }

  try {
    const boundedStatement = {
      ...statement,
      limit: boundedLimit(statement.limit, maximumRows),
    } as unknown as Select;
    return parser.sqlify(boundedStatement, { database: 'MySQL' });
  } catch {
    throw new SqlPolicyError();
  }
}
