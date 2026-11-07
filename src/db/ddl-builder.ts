import { normalizeAlterTableAddColumnInput, type AlterTableAddColumnInput } from '../tools/alter-table-add-column-input.js';
import { normalizeAlterTableAddForeignKeyInput, type AlterTableAddForeignKeyInput } from '../tools/alter-table-add-foreign-key-input.js';
import { normalizeAlterTableModifyColumnInput, type AlterTableModifyColumnInput } from '../tools/alter-table-modify-column-input.js';
import { normalizeAlterTableRenameColumnInput, type AlterTableRenameColumnInput } from '../tools/alter-table-rename-column-input.js';
import { normalizeCreateIndexInput, type CreateIndexInput } from '../tools/create-index-input.js';
import { normalizeCreateTableInput, type CreateTableColumn, type CreateTableColumnType, type CreateTableInput } from '../tools/create-table-input.js';
import { normalizeCreateUniqueIndexInput, type CreateUniqueIndexInput } from '../tools/create-unique-index-input.js';
import { normalizeRenameTableInput, type RenameTableInput } from '../tools/rename-table-input.js';

export interface BuiltCreateTableStatement {
  readonly sql: string;
}
export interface BuiltCreateIndexStatement {
  readonly sql: string;
}
export interface BuiltCreateUniqueIndexStatement {
  readonly sql: string;
}
export interface BuiltAlterTableAddColumnStatement {
  readonly sql: string;
}
export interface BuiltAlterTableAddForeignKeyStatement {
  readonly sql: string;
}
export interface BuiltAlterTableModifyColumnStatement {
  readonly sql: string;
}
export interface BuiltAlterTableRenameColumnStatement {
  readonly sql: string;
}
export interface BuiltRenameTableStatement {
  readonly sql: string;
}

function escapeIdentifier(identifier: string): string {
  return `\`${identifier.replaceAll('`', '``')}\``;
}

function renderColumnType(type: CreateTableColumnType): string {
  switch (type.kind) {
    case 'integer':
      return `${type.integerType.toUpperCase()}${type.unsigned === true ? ' UNSIGNED' : ''}`;
    case 'decimal':
      return `DECIMAL(${type.precision},${type.scale})`;
    case 'char':
    case 'varchar':
      return `${type.kind.toUpperCase()}(${type.length})`;
    case 'text':
      return 'TEXT';
    case 'date':
      return 'DATE';
    case 'boolean':
      return 'TINYINT(1)';
    case 'json':
      return 'JSON';
    case 'time':
    case 'datetime':
    case 'timestamp':
      return `${type.kind.toUpperCase()}${type.fractionalSecondsPrecision === undefined ? '' : `(${type.fractionalSecondsPrecision})`}`;
  }
}

function renderColumn(column: CreateTableColumn): string {
  return `${escapeIdentifier(column.name)} ${renderColumnType(column.type)} ${column.nullable ? 'NULL' : 'NOT NULL'}${
    column.autoIncrement === true ? ' AUTO_INCREMENT' : ''
  }`;
}

function renderAlterTableModifyColumn(column: AlterTableModifyColumnInput['definition']): string {
  let definition = `${escapeIdentifier(column.name)} ${renderColumnType(column.type)}`;
  if (column.characterSet === undefined && column.collation === undefined) {
    definition += ` ${column.nullable ? 'NULL' : 'NOT NULL'}${column.autoIncrement === true ? ' AUTO_INCREMENT' : ''}`;
    return definition;
  }
  if (column.characterSet === undefined || column.collation === undefined) throw new Error('Character set and collation must be provided together.');
  definition += ` CHARACTER SET ${column.characterSet} COLLATE ${column.collation}`;
  return `${definition} ${column.nullable ? 'NULL' : 'NOT NULL'}${column.autoIncrement === true ? ' AUTO_INCREMENT' : ''}`;
}

/**
 * Produces the sole canonical SQL representation for the supported CREATE TABLE
 * input. It defensively normalizes again so callers cannot pass an object cast
 * to the normal-form TypeScript type.
 */
export function buildCreateTableStatement(input: CreateTableInput): BuiltCreateTableStatement {
  const normalized = normalizeCreateTableInput(input);
  const columns = normalized.columns.map(renderColumn);
  const primaryKey = normalized.primaryKey.map(escapeIdentifier).join(', ');
  const sql = `CREATE TABLE ${escapeIdentifier(normalized.schema)}.${escapeIdentifier(normalized.table)} (${[...columns, `PRIMARY KEY (${primaryKey})`].join(', ')})`;
  return Object.freeze({ sql });
}

/** Produces the sole canonical SQL representation for the supported CREATE INDEX input. */
export function buildCreateIndexStatement(input: CreateIndexInput): BuiltCreateIndexStatement {
  const normalized = normalizeCreateIndexInput(input);
  return Object.freeze({
    sql: `CREATE INDEX ${escapeIdentifier(normalized.index)} ON ${escapeIdentifier(normalized.schema)}.${escapeIdentifier(normalized.table)} (${normalized.columns.map(escapeIdentifier).join(', ')})`,
  });
}

/** Produces the sole canonical SQL representation for the supported CREATE UNIQUE INDEX input. */
export function buildCreateUniqueIndexStatement(input: CreateUniqueIndexInput): BuiltCreateUniqueIndexStatement {
  const normalized = normalizeCreateUniqueIndexInput(input);
  return Object.freeze({
    sql: `CREATE UNIQUE INDEX ${escapeIdentifier(normalized.index)} ON ${escapeIdentifier(normalized.schema)}.${escapeIdentifier(normalized.table)} (${normalized.columns.map(escapeIdentifier).join(', ')})`,
  });
}

/** Produces the sole canonical SQL representation for one nullable ADD COLUMN request. */
export function buildAlterTableAddColumnStatement(input: AlterTableAddColumnInput): BuiltAlterTableAddColumnStatement {
  const normalized = normalizeAlterTableAddColumnInput(input);
  return Object.freeze({
    sql: `ALTER TABLE ${escapeIdentifier(normalized.schema)}.${escapeIdentifier(normalized.table)} ADD COLUMN ${renderColumn(normalized.column)}`,
  });
}

/** Produces the canonical, intra-schema ADD CONSTRAINT FOREIGN KEY statement. */
export function buildAlterTableAddForeignKeyStatement(input: AlterTableAddForeignKeyInput): BuiltAlterTableAddForeignKeyStatement {
  const normalized = normalizeAlterTableAddForeignKeyInput(input);
  return Object.freeze({
    sql: `ALTER TABLE ${escapeIdentifier(normalized.schema)}.${escapeIdentifier(normalized.table)} ADD CONSTRAINT ${escapeIdentifier(normalized.constraint)} FOREIGN KEY (${normalized.columns.map(escapeIdentifier).join(', ')}) REFERENCES ${escapeIdentifier(normalized.schema)}.${escapeIdentifier(normalized.referencedTable)} (${normalized.referencedColumns.map(escapeIdentifier).join(', ')}) ON DELETE ${normalized.onDelete} ON UPDATE ${normalized.onUpdate}`,
  });
}

/** Produces the canonical one-column MODIFY COLUMN statement. */
export function buildAlterTableModifyColumnStatement(input: AlterTableModifyColumnInput): BuiltAlterTableModifyColumnStatement {
  const normalized = normalizeAlterTableModifyColumnInput(input);
  return Object.freeze({
    sql: `ALTER TABLE ${escapeIdentifier(normalized.schema)}.${escapeIdentifier(normalized.table)} MODIFY COLUMN ${renderAlterTableModifyColumn(normalized.definition)}`,
  });
}

/** Produces the canonical one-column RENAME COLUMN statement. */
export function buildAlterTableRenameColumnStatement(input: AlterTableRenameColumnInput): BuiltAlterTableRenameColumnStatement {
  const normalized = normalizeAlterTableRenameColumnInput(input);
  return Object.freeze({
    sql: `ALTER TABLE ${escapeIdentifier(normalized.schema)}.${escapeIdentifier(normalized.table)} RENAME COLUMN ${escapeIdentifier(normalized.column)} TO ${escapeIdentifier(normalized.newColumn)}`,
  });
}

/** Produces the canonical, intra-schema one-table RENAME TABLE statement. */
export function buildRenameTableStatement(input: RenameTableInput): BuiltRenameTableStatement {
  const normalized = normalizeRenameTableInput(input);
  return Object.freeze({
    sql: `RENAME TABLE ${escapeIdentifier(normalized.schema)}.${escapeIdentifier(normalized.table)} TO ${escapeIdentifier(normalized.schema)}.${escapeIdentifier(normalized.newTable)}`,
  });
}
