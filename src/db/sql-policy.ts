import sqlParser from 'node-sql-parser';

import { MAX_ALTER_TABLE_FOREIGN_KEY_COLUMNS } from '../tools/alter-table-add-foreign-key-input.js';
import { MAX_CREATE_INDEX_COLUMNS } from '../tools/create-index-input.js';
import { MAX_CREATE_TABLE_COLUMNS, MAX_CREATE_TABLE_IDENTIFIER_LENGTH } from '../tools/create-table-input.js';

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

export class DdlPolicyError extends Error {
  readonly code = 'MYSQL_SQL_NOT_DDL';

  constructor() {
    super('Only one internally generated CREATE TABLE statement is allowed.');
    this.name = 'DdlPolicyError';
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

const MAX_CREATE_TABLE_SQL_LENGTH = 65_536;
const UNSAFE_IDENTIFIER_CHARACTER = /[`"\p{Cc}\p{Cf}\u2028\u2029]/u;

type CreateTableColumnKind = 'integer' | 'other';
type ParsedCreateTableColumn = Readonly<{ name: string; kind: CreateTableColumnKind; nullable: boolean; autoIncrement: boolean }>;

function failDdlPolicy(): never {
  throw new DdlPolicyError();
}

function isCanonicalInteger(value: string, minimum: number, maximum: number): boolean {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) return false;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= minimum && numeric <= maximum;
}

function readExpected(sql: string, index: number, expected: string): number {
  if (!sql.startsWith(expected, index)) failDdlPolicy();
  return index + expected.length;
}

function readIdentifier(sql: string, index: number): readonly [string, number] {
  if (sql[index] !== '`') failDdlPolicy();
  const end = sql.indexOf('`', index + 1);
  if (end < 0) failDdlPolicy();
  const identifier = sql.slice(index + 1, end);
  if (identifier.length === 0 || Array.from(identifier).length > MAX_CREATE_TABLE_IDENTIFIER_LENGTH || UNSAFE_IDENTIFIER_CHARACTER.test(identifier)) {
    failDdlPolicy();
  }
  return [identifier, end + 1];
}

function readMetadataName(sql: string, index: number): readonly [string, number] {
  const match = /^[A-Za-z0-9_]+/u.exec(sql.slice(index));
  if (match === null) failDdlPolicy();
  return [match[0], index + match[0].length];
}

function readColumnType(sql: string, index: number): readonly [CreateTableColumnKind, number] {
  if (sql.startsWith('TINYINT(1)', index)) return ['other', index + 'TINYINT(1)'.length];

  const integer = /^(?:TINYINT|SMALLINT|MEDIUMINT|INT|BIGINT)(?: UNSIGNED)?/u.exec(sql.slice(index));
  if (integer !== null) return ['integer', index + integer[0].length];

  const decimal = /^DECIMAL\(([0-9]+),([0-9]+)\)/u.exec(sql.slice(index));
  if (decimal !== null) {
    if (!isCanonicalInteger(decimal[1], 1, 65) || !isCanonicalInteger(decimal[2], 0, 30) || Number(decimal[2]) > Number(decimal[1])) {
      failDdlPolicy();
    }
    return ['other', index + decimal[0].length];
  }

  const text = /^(?:CHAR|VARCHAR)\(([0-9]+)\)/u.exec(sql.slice(index));
  if (text !== null) {
    if (!isCanonicalInteger(text[1], 1, 255)) failDdlPolicy();
    return ['other', index + text[0].length];
  }

  const temporal = /^(?:TIMESTAMP|DATETIME|TIME)(?:\([0-6]\))?/u.exec(sql.slice(index));
  if (temporal !== null) return ['other', index + temporal[0].length];

  for (const type of ['TEXT', 'DATE', 'JSON'] as const) {
    if (sql.startsWith(type, index)) return ['other', index + type.length];
  }
  failDdlPolicy();
}

function readColumn(sql: string, index: number): readonly [ParsedCreateTableColumn, number] {
  const [name, afterName] = readIdentifier(sql, index);
  const [kind, afterType] = readColumnType(sql, readExpected(sql, afterName, ' '));
  let next = afterType;
  if (sql.startsWith(' CHARACTER SET ', next)) {
    next += ' CHARACTER SET '.length;
    [, next] = readMetadataName(sql, next);
    next = readExpected(sql, next, ' COLLATE ');
    [, next] = readMetadataName(sql, next);
  } else if (sql.startsWith(' COLLATE ', next)) {
    failDdlPolicy();
  }
  let nullable: boolean;
  if (sql.startsWith(' NOT NULL', next)) {
    nullable = false;
    next += ' NOT NULL'.length;
  } else if (sql.startsWith(' NULL', next)) {
    nullable = true;
    next += ' NULL'.length;
  } else {
    failDdlPolicy();
  }
  const autoIncrement = sql.startsWith(' AUTO_INCREMENT', next);
  if (autoIncrement) next += ' AUTO_INCREMENT'.length;
  return [Object.freeze({ name, kind, nullable, autoIncrement }), next];
}

/**
 * Defense in depth for the DDL capability: accept only the canonical single
 * CREATE TABLE grammar emitted by the internal builder.
 */
export function assertCreateTableSql(sql: string): void {
  if (typeof sql !== 'string' || sql.length > MAX_CREATE_TABLE_SQL_LENGTH) failDdlPolicy();
  let index = readExpected(sql, 0, 'CREATE TABLE ');
  [, index] = readIdentifier(sql, index);
  index = readExpected(sql, index, '.');
  [, index] = readIdentifier(sql, index);
  index = readExpected(sql, index, ' (');

  const columns: ParsedCreateTableColumn[] = [];
  const declaredColumns = new Set<string>();
  while (true) {
    const [column, afterColumn] = readColumn(sql, index);
    if (declaredColumns.has(column.name) || columns.length >= MAX_CREATE_TABLE_COLUMNS) failDdlPolicy();
    columns.push(column);
    declaredColumns.add(column.name);
    index = afterColumn;
    if (sql.startsWith(', PRIMARY KEY (', index)) {
      index += ', PRIMARY KEY ('.length;
      break;
    }
    index = readExpected(sql, index, ', ');
  }

  const primaryKey: string[] = [];
  const primaryKeyColumns = new Set<string>();
  while (true) {
    const [name, afterName] = readIdentifier(sql, index);
    if (!declaredColumns.has(name) || primaryKeyColumns.has(name) || primaryKey.length >= MAX_CREATE_TABLE_COLUMNS) failDdlPolicy();
    primaryKey.push(name);
    primaryKeyColumns.add(name);
    index = afterName;
    if (sql[index] === ')') {
      index += 1;
      break;
    }
    index = readExpected(sql, index, ', ');
  }
  index = readExpected(sql, index, ')');
  if (index !== sql.length) failDdlPolicy();

  const autoIncrementColumns = columns.filter((column) => column.autoIncrement);
  if (
    autoIncrementColumns.length > 1 ||
    (autoIncrementColumns.length === 1 &&
      (autoIncrementColumns[0].kind !== 'integer' || autoIncrementColumns[0].nullable || primaryKey[0] !== autoIncrementColumns[0].name))
  ) {
    failDdlPolicy();
  }
}

/** Defense in depth for the canonical, plain non-unique B-tree CREATE INDEX grammar. */
export function assertCreateIndexSql(sql: string): void {
  if (typeof sql !== 'string' || sql.length > MAX_CREATE_TABLE_SQL_LENGTH) failDdlPolicy();
  let index = readExpected(sql, 0, 'CREATE INDEX ');
  [, index] = readIdentifier(sql, index);
  index = readExpected(sql, index, ' ON ');
  [, index] = readIdentifier(sql, index);
  index = readExpected(sql, index, '.');
  [, index] = readIdentifier(sql, index);
  index = readExpected(sql, index, ' (');
  const columns = new Set<string>();
  while (true) {
    const [column, afterColumn] = readIdentifier(sql, index);
    if (columns.has(column) || columns.size >= MAX_CREATE_INDEX_COLUMNS) failDdlPolicy();
    columns.add(column);
    index = afterColumn;
    if (sql[index] === ')') {
      index += 1;
      break;
    }
    index = readExpected(sql, index, ', ');
  }
  if (index !== sql.length || columns.size === 0) failDdlPolicy();
}

/** Defense in depth for the canonical, plain unique B-tree CREATE INDEX grammar. */
export function assertCreateUniqueIndexSql(sql: string): void {
  if (typeof sql !== 'string' || !sql.startsWith('CREATE UNIQUE INDEX ')) failDdlPolicy();
  assertCreateIndexSql(`CREATE INDEX ${sql.slice('CREATE UNIQUE INDEX '.length)}`);
}

/** Defense in depth for the canonical, named secondary-index DROP INDEX grammar. */
export function assertDropIndexSql(sql: string): void {
  if (typeof sql !== 'string' || sql.length > MAX_CREATE_TABLE_SQL_LENGTH) failDdlPolicy();
  let index = readExpected(sql, 0, 'DROP INDEX ');
  [, index] = readIdentifier(sql, index);
  index = readExpected(sql, index, ' ON ');
  [, index] = readIdentifier(sql, index);
  index = readExpected(sql, index, '.');
  [, index] = readIdentifier(sql, index);
  if (index !== sql.length) failDdlPolicy();
}

/** Defense in depth for the canonical named foreign-key DROP grammar. */
export function assertAlterTableDropForeignKeySql(sql: string): void {
  if (typeof sql !== 'string' || sql.length > MAX_CREATE_TABLE_SQL_LENGTH) failDdlPolicy();
  let index = readExpected(sql, 0, 'ALTER TABLE ');
  [, index] = readIdentifier(sql, index);
  index = readExpected(sql, index, '.');
  [, index] = readIdentifier(sql, index);
  index = readExpected(sql, index, ' DROP FOREIGN KEY ');
  [, index] = readIdentifier(sql, index);
  if (index !== sql.length) failDdlPolicy();
}

/** Defense in depth for the canonical one-column nullable ALTER TABLE grammar. */
export function assertAlterTableAddColumnSql(sql: string): void {
  if (typeof sql !== 'string' || sql.length > MAX_CREATE_TABLE_SQL_LENGTH) failDdlPolicy();
  let index = readExpected(sql, 0, 'ALTER TABLE ');
  [, index] = readIdentifier(sql, index);
  index = readExpected(sql, index, '.');
  [, index] = readIdentifier(sql, index);
  index = readExpected(sql, index, ' ADD COLUMN ');
  const [column, afterColumn] = readColumn(sql, index);
  if (!column.nullable || column.autoIncrement || afterColumn !== sql.length) failDdlPolicy();
}

/** Defense in depth for the canonical one-column ALTER TABLE MODIFY COLUMN grammar. */
export function assertAlterTableModifyColumnSql(sql: string): void {
  if (typeof sql !== 'string' || sql.length > MAX_CREATE_TABLE_SQL_LENGTH) failDdlPolicy();
  let index = readExpected(sql, 0, 'ALTER TABLE ');
  [, index] = readIdentifier(sql, index);
  index = readExpected(sql, index, '.');
  [, index] = readIdentifier(sql, index);
  index = readExpected(sql, index, ' MODIFY COLUMN ');
  const [, afterColumn] = readColumn(sql, index);
  if (afterColumn !== sql.length) failDdlPolicy();
}

/** Defense in depth for the canonical one-column RENAME COLUMN grammar. */
export function assertAlterTableRenameColumnSql(sql: string): void {
  if (typeof sql !== 'string' || sql.length > MAX_CREATE_TABLE_SQL_LENGTH) failDdlPolicy();
  let index = readExpected(sql, 0, 'ALTER TABLE ');
  [, index] = readIdentifier(sql, index);
  index = readExpected(sql, index, '.');
  [, index] = readIdentifier(sql, index);
  index = readExpected(sql, index, ' RENAME COLUMN ');
  const [oldName, afterOldName] = readIdentifier(sql, index);
  index = readExpected(sql, afterOldName, ' TO ');
  const [newName, afterNewName] = readIdentifier(sql, index);
  if (oldName === newName || afterNewName !== sql.length) failDdlPolicy();
}

/** Defense in depth for the canonical, intra-schema one-table RENAME TABLE grammar. */
export function assertRenameTableSql(sql: string): void {
  if (typeof sql !== 'string' || sql.length > MAX_CREATE_TABLE_SQL_LENGTH) failDdlPolicy();
  let index = readExpected(sql, 0, 'RENAME TABLE ');
  const [schema, afterSchema] = readIdentifier(sql, index);
  index = readExpected(sql, afterSchema, '.');
  const [oldTable, afterOldTable] = readIdentifier(sql, index);
  index = afterOldTable;
  index = readExpected(sql, index, ' TO ');
  const [newSchema, afterNewSchema] = readIdentifier(sql, index);
  if (schema !== newSchema) failDdlPolicy();
  index = readExpected(sql, afterNewSchema, '.');
  const [newTable, afterNewTable] = readIdentifier(sql, index);
  if (afterNewTable !== sql.length || newTable.length === 0 || oldTable.toLocaleLowerCase('en-US') === newTable.toLocaleLowerCase('en-US'))
    failDdlPolicy();
}

/** Defense in depth for the canonical, intra-schema ADD CONSTRAINT FOREIGN KEY grammar. */
export function assertAlterTableAddForeignKeySql(sql: string): void {
  if (typeof sql !== 'string' || sql.length > MAX_CREATE_TABLE_SQL_LENGTH) failDdlPolicy();
  let index = readExpected(sql, 0, 'ALTER TABLE ');
  const [schema, afterSchema] = readIdentifier(sql, index);
  index = afterSchema;
  index = readExpected(sql, index, '.');
  [, index] = readIdentifier(sql, index);
  index = readExpected(sql, index, ' ADD CONSTRAINT ');
  [, index] = readIdentifier(sql, index);
  index = readExpected(sql, index, ' FOREIGN KEY (');
  const localColumns = new Set<string>();
  while (true) {
    const [column, afterColumn] = readIdentifier(sql, index);
    if (localColumns.has(column) || localColumns.size >= MAX_ALTER_TABLE_FOREIGN_KEY_COLUMNS) failDdlPolicy();
    localColumns.add(column);
    index = afterColumn;
    if (sql[index] === ')') {
      index += 1;
      break;
    }
    index = readExpected(sql, index, ', ');
  }
  index = readExpected(sql, index, ' REFERENCES ');
  const [referencedSchema, afterReferencedSchema] = readIdentifier(sql, index);
  index = afterReferencedSchema;
  if (referencedSchema !== schema) failDdlPolicy();
  index = readExpected(sql, index, '.');
  [, index] = readIdentifier(sql, index);
  index = readExpected(sql, index, ' (');
  const referencedColumns = new Set<string>();
  while (true) {
    const [column, afterColumn] = readIdentifier(sql, index);
    if (referencedColumns.has(column) || referencedColumns.size >= MAX_ALTER_TABLE_FOREIGN_KEY_COLUMNS) failDdlPolicy();
    referencedColumns.add(column);
    index = afterColumn;
    if (sql[index] === ')') {
      index += 1;
      break;
    }
    index = readExpected(sql, index, ', ');
  }
  if (localColumns.size === 0 || localColumns.size !== referencedColumns.size) failDdlPolicy();
  index = readExpected(sql, index, ' ON DELETE ');
  if (sql.startsWith('RESTRICT', index)) index += 'RESTRICT'.length;
  else if (sql.startsWith('NO ACTION', index)) index += 'NO ACTION'.length;
  else failDdlPolicy();
  index = readExpected(sql, index, ' ON UPDATE ');
  if (sql.startsWith('RESTRICT', index)) index += 'RESTRICT'.length;
  else if (sql.startsWith('NO ACTION', index)) index += 'NO ACTION'.length;
  else failDdlPolicy();
  if (index !== sql.length) failDdlPolicy();
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
