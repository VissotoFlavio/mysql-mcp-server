import { normalizeCreateTableInput, type CreateTableColumn, type CreateTableColumnType, type CreateTableInput } from '../tools/create-table-input.js';

export interface BuiltCreateTableStatement {
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
