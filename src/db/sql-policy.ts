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

function containsUnsafeNestedStatement(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsUnsafeNestedStatement);
  }

  if (!isAstNode(value)) {
    return false;
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

export function assertReadOnlySql(sql: string): void {
  if (typeof sql !== 'string' || sql.includes('/*!')) {
    throw new SqlPolicyError();
  }

  let ast: unknown;
  try {
    ast = parser.astify(sql, { database: 'MySQL' });
  } catch {
    throw new SqlPolicyError();
  }

  if (Array.isArray(ast) || !isAstNode(ast) || !isSafeStatement(ast)) {
    throw new SqlPolicyError();
  }
}
