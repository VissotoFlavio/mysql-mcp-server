import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DmlInputValidationError,
  MAX_DML_COLUMNS,
  MAX_DML_IDENTIFIER_LENGTH,
  MAX_DML_PARAMETERS,
  MAX_DML_PAYLOAD_BYTES,
  MAX_DML_REASON_LENGTH,
  MAX_DML_ROWS,
  MAX_DML_STRING_LENGTH,
  assertDmlColumnCount,
  assertDmlParameterCount,
  assertDmlPayloadSize,
  countDmlColumns,
  countDmlParameters,
  isDmlScalar,
  isDmlValue,
  normalizeDmlIdentifier,
  normalizeDmlReason,
  normalizeDmlRow,
  normalizeDmlRows,
  normalizeDmlTarget,
  normalizeDmlValue,
} from '../../src/tools/dml-input.js';

function errorOf(action: () => unknown): DmlInputValidationError {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof DmlInputValidationError);
    return error;
  }

  assert.fail('Expected a DML validation error.');
}

function assertError(action: () => unknown, code: DmlInputValidationError['code'], path: string): void {
  const error = errorOf(action);
  assert.equal(error.code, code);
  assert.equal(error.path, path);
}

function repeatedCharacterPayload(bytes: number): string {
  const prefix = JSON.stringify({ value: '' });
  return 'x'.repeat(bytes - Buffer.byteLength(prefix, 'utf8'));
}

test('normalizes valid targets, reasons, scalar values, and rows without changing values', () => {
  const target = normalizeDmlTarget({ schema: '分析', table: 'clientes é', reason: '  corrigir cadastro  ' });
  assert.deepEqual(target, { schema: '分析', table: 'clientes é', reason: 'corrigir cadastro' });
  assert.equal(normalizeDmlValue('00000000000000000001'), '00000000000000000001');
  assert.equal(normalizeDmlValue(1.25), 1.25);
  assert.equal(normalizeDmlValue(true), true);
  assert.equal(normalizeDmlValue(null), null);
  assert.deepEqual(normalizeDmlRow({ nomé: '0007', ativo: true }), { nomé: '0007', ativo: true });
});

test('counts distinct columns and prepared parameters for reusable contracts', () => {
  assert.equal(countDmlColumns(['id', 'name'], ['name', 'status']), 3);
  assert.equal(countDmlParameters([1, 2], ['filter'], []), 3);
  assert.equal(assertDmlColumnCount(['id', 'id']), 1);
  assert.equal(assertDmlParameterCount([1, 2]), 2);
});

test('counts Unicode code points rather than UTF-16 code units', () => {
  assert.equal(normalizeDmlValue('😀'.repeat(MAX_DML_STRING_LENGTH)), '😀'.repeat(MAX_DML_STRING_LENGTH));
  assert.equal(normalizeDmlIdentifier('界'.repeat(MAX_DML_IDENTIFIER_LENGTH)), '界'.repeat(MAX_DML_IDENTIFIER_LENGTH));
  assert.equal(normalizeDmlReason(` ${'😀'.repeat(MAX_DML_REASON_LENGTH)} `), '😀'.repeat(MAX_DML_REASON_LENGTH));
});

test('scalar guards enforce finite numbers and the Unicode string limit', () => {
  assert.equal(isDmlScalar('a'.repeat(MAX_DML_STRING_LENGTH)), true);
  assert.equal(isDmlScalar('a'.repeat(MAX_DML_STRING_LENGTH + 1)), false);
  assert.equal(isDmlValue('😀'.repeat(MAX_DML_STRING_LENGTH + 1)), false);
  assert.equal(isDmlScalar('line\u0000break'), false);
  assert.equal(isDmlScalar(NaN), false);
  assert.equal(isDmlScalar(Infinity), false);
  assert.equal(isDmlScalar(Number.MAX_SAFE_INTEGER + 1), false);
});

test('rejects strings at limit plus one while accepting each limit exactly', () => {
  normalizeDmlValue('a'.repeat(MAX_DML_STRING_LENGTH));
  assertError(() => normalizeDmlValue('a'.repeat(MAX_DML_STRING_LENGTH + 1)), 'string_too_long', 'value');

  normalizeDmlIdentifier('a'.repeat(MAX_DML_IDENTIFIER_LENGTH));
  assertError(() => normalizeDmlIdentifier('a'.repeat(MAX_DML_IDENTIFIER_LENGTH + 1)), 'string_too_long', 'identifier');

  normalizeDmlReason('a'.repeat(MAX_DML_REASON_LENGTH));
  assertError(() => normalizeDmlReason('a'.repeat(MAX_DML_REASON_LENGTH + 1)), 'string_too_long', 'reason');
});

test('rejects empty and control-character identifiers and reasons', () => {
  assertError(() => normalizeDmlIdentifier(''), 'invalid_value', 'identifier');
  assertError(() => normalizeDmlIdentifier('customer\u0000name'), 'control_character', 'identifier');
  for (const control of ['\u200B', '\u202E', '\uFEFF']) {
    assertError(() => normalizeDmlIdentifier(`customer${control}name`), 'control_character', 'identifier');
    assertError(() => normalizeDmlReason(`valid${control}reason`), 'control_character', 'reason');
    assertError(() => normalizeDmlValue(`valid${control}value`), 'control_character', 'value');
  }
  for (const separator of ['\u2028', '\u2029']) {
    assertError(() => normalizeDmlReason(`valid${separator}reason`), 'control_character', 'reason');
  }
  assertError(() => normalizeDmlReason('   '), 'invalid_value', 'reason');
  assertError(() => normalizeDmlReason('valid\nreason'), 'control_character', 'reason');
  assertError(() => normalizeDmlReason('\tvalid'), 'control_character', 'reason');
});

test('rejects non-finite and unsafe numbers with deterministic safe errors', () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    assertError(() => normalizeDmlValue(value), 'invalid_value', 'value');
  }

  for (const value of [Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1]) {
    const error = errorOf(() => normalizeDmlValue(value));
    assert.equal(error.code, 'unsafe_integer');
    assert.equal(error.path, 'value');
    assert.match(error.message, /provide the value as a string/);
    assert.doesNotMatch(error.message, new RegExp(String(value)));
  }
});

test('rejects missing and additional properties in exact target shapes', () => {
  assertError(() => normalizeDmlTarget({ schema: 'app', table: 'users' }), 'missing_property', 'reason');
  assertError(() => normalizeDmlTarget({ schema: 'app', table: 'users', reason: 'audit', extra: 'secret-value' }), 'additional_property', 'input');
  const error = errorOf(() => normalizeDmlTarget({ schema: 'app', table: 'users', reason: 'secret-value', extra: 'secret-value' }));
  assert.equal(error.path, 'input');
  assert.doesNotMatch(error.message, /secret-value/);
});

test('rejects malformed arrays and requires matching row columns', () => {
  const sparse = [] as unknown[];
  sparse.length = 1;
  assertError(() => normalizeDmlRows(sparse), 'sparse_array', 'rows');
  const sparseRows = [] as unknown[];
  sparseRows[0] = { id: 1 };
  sparseRows[2] = { id: 3 };
  assertError(() => normalizeDmlRows(sparseRows), 'sparse_array', 'rows');
  assertError(() => normalizeDmlRows([]), 'row_limit_exceeded', 'rows');
  assertError(() => normalizeDmlRows([{ id: 1 }, { name: 'other' }]), 'inconsistent_columns', 'rows');
  assertError(() => normalizeDmlRow(['not', 'a', 'row']), 'invalid_type', 'row');
});

test('enforces column and parameter limits at limit minus one, limit, and limit plus one', () => {
  for (const count of [MAX_DML_COLUMNS - 1, MAX_DML_COLUMNS]) {
    assert.equal(assertDmlColumnCount(count), count);
  }
  assertError(() => assertDmlColumnCount(MAX_DML_COLUMNS + 1), 'column_limit_exceeded', 'columns');
  assert.equal(countDmlColumns(Array.from({ length: MAX_DML_COLUMNS }, (_, index) => `c${index}`)), MAX_DML_COLUMNS);

  for (const count of [MAX_DML_PARAMETERS - 1, MAX_DML_PARAMETERS]) {
    assert.equal(assertDmlParameterCount(count), count);
  }
  assertError(() => assertDmlParameterCount(MAX_DML_PARAMETERS + 1), 'parameter_limit_exceeded', 'parameters');
});

test('enforces column and parameter limits through direct row validation', () => {
  const rowAtColumnLimit = Object.fromEntries(Array.from({ length: MAX_DML_COLUMNS }, (_, index) => [`c${index}`, index]));
  assert.equal(Object.keys(normalizeDmlRow(rowAtColumnLimit)).length, MAX_DML_COLUMNS);

  const rowOverColumnLimit = Object.fromEntries(Array.from({ length: MAX_DML_COLUMNS + 1 }, (_, index) => [`c${index}`, index]));
  assertError(() => normalizeDmlRow(rowOverColumnLimit), 'column_limit_exceeded', 'row.columns');
  assert.equal(assertDmlParameterCount(MAX_DML_PARAMETERS), MAX_DML_PARAMETERS);
  assertError(() => assertDmlParameterCount(MAX_DML_PARAMETERS + 1), 'parameter_limit_exceeded', 'parameters');
});

test('bounds row collections before materializing future DML operations', () => {
  assert.equal(normalizeDmlRows([{ id: 1 }]).length, 1);
  assert.equal(normalizeDmlRows(Array.from({ length: MAX_DML_ROWS }, () => ({ id: 1 }))).length, MAX_DML_ROWS);
  assertError(() => normalizeDmlRows(Array.from({ length: MAX_DML_ROWS + 1 }, () => ({ id: 1 }))), 'row_limit_exceeded', 'rows');
  assertError(() => normalizeDmlRows([{}]), 'row_limit_exceeded', 'rows.columns');
});

test('rejects invalid runtime inputs to reusable count helpers', () => {
  assertError(() => countDmlColumns('id' as never), 'invalid_type', 'columns[0]');
  assertError(() => countDmlColumns(['id', 1] as never), 'invalid_type', 'columns[0][1]');

  const sparseColumns = [] as string[];
  sparseColumns.length = 1;
  assertError(() => countDmlColumns(sparseColumns), 'sparse_array', 'columns[0]');
  assertError(() => countDmlParameters('not-an-array' as never), 'invalid_type', 'parameters[0]');

  const sparseParameters = [] as unknown[];
  sparseParameters.length = 1;
  assertError(() => countDmlParameters(sparseParameters), 'sparse_array', 'parameters[0]');
});

test('enforces the UTF-8 payload byte limit before normalization', () => {
  const below = { value: repeatedCharacterPayload(MAX_DML_PAYLOAD_BYTES - 1) };
  const exact = { value: repeatedCharacterPayload(MAX_DML_PAYLOAD_BYTES) };
  assert.equal(assertDmlPayloadSize(below), MAX_DML_PAYLOAD_BYTES - 1);
  assert.equal(assertDmlPayloadSize(exact), MAX_DML_PAYLOAD_BYTES);
  const unicodePayload = { value: '😀'.repeat(1_000) };
  assert.equal(assertDmlPayloadSize(unicodePayload), new TextEncoder().encode(JSON.stringify(unicodePayload)).byteLength);
  assertError(() => assertDmlPayloadSize({ value: repeatedCharacterPayload(MAX_DML_PAYLOAD_BYTES + 1) }), 'payload_too_large', 'input');
});

test('rejects unsafe JSON object shapes without raw exceptions or dynamic key disclosure', () => {
  const accessor = {} as Record<string, unknown>;
  let accessorRead = false;
  Object.defineProperty(accessor, 'value', {
    enumerable: true,
    get: () => {
      accessorRead = true;
      throw new Error('secret getter');
    },
  });
  assertError(() => assertDmlPayloadSize({ nested: accessor }), 'invalid_payload', 'input');
  assert.equal(accessorRead, false);

  const nonEnumerable = {} as Record<string, unknown>;
  Object.defineProperty(nonEnumerable, 'value', { enumerable: false, value: 'secret-value' });
  assertError(() => assertDmlPayloadSize({ nested: nonEnumerable }), 'invalid_payload', 'input');

  const withToJson = { value: 'secret-value' } as Record<string, unknown> & { toJSON?: () => unknown };
  withToJson.toJSON = () => 'secret-value';
  assertError(() => assertDmlPayloadSize({ nested: withToJson }), 'invalid_payload', 'input');

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assertError(() => assertDmlPayloadSize({ nested: cyclic }), 'invalid_payload', 'input');

  const symbolKey = { value: 'secret-value' } as Record<string, unknown>;
  Object.defineProperty(symbolKey, Symbol('secret-symbol'), { enumerable: true, value: 'secret-value' });
  assertError(() => assertDmlPayloadSize({ nested: symbolKey }), 'invalid_payload', 'input');

  const proxied = new Proxy(
    { value: 'x'.repeat(MAX_DML_PAYLOAD_BYTES) },
    {
      get(target, property, receiver) {
        if (property === 'toJSON') {
          return () => ({}) as unknown;
        }

        return Reflect.get(target, property, receiver);
      },
    },
  );
  assertError(() => assertDmlPayloadSize(proxied), 'invalid_payload', 'input');

  const reordered = new Proxy([{ id: 1 }, { id: 2 }], { ownKeys: () => ['1', '0', 'length'] });
  assertError(() => normalizeDmlRows(reordered), 'invalid_payload', 'rows');
  assert.equal(countDmlColumns(new Proxy(['id', 'name'], { ownKeys: () => ['1', '0', 'length'] })), 2);

  const malformedPath = {} as { length: number };
  Object.defineProperty(malformedPath, 'length', {
    get: () => {
      throw new Error('secret path');
    },
  });
  assertError(() => assertDmlPayloadSize({ value: Symbol('secret') }, malformedPath as never), 'invalid_payload', 'input');

  const originalArrayToJson = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
  try {
    const pollutedDuringEnumeration = new Proxy([{ value: 'x'.repeat(MAX_DML_PAYLOAD_BYTES) }], {
      ownKeys(target) {
        Object.defineProperty(Array.prototype, 'toJSON', { configurable: true, value: () => [] });
        return Reflect.ownKeys(target);
      },
    });
    assertError(() => assertDmlPayloadSize(pollutedDuringEnumeration), 'invalid_payload', 'input');
    assert.equal(JSON.stringify([1]), '[1]');
  } finally {
    if (originalArrayToJson === undefined) {
      delete (Array.prototype as Array<unknown> & { toJSON?: unknown }).toJSON;
    } else {
      Object.defineProperty(Array.prototype, 'toJSON', originalArrayToJson);
    }
  }

  const secretControlColumn = { ['secret\u0000column']: 1 };
  const error = errorOf(() => normalizeDmlRow(secretControlColumn));
  assert.equal(error.path, 'row.column');
  assert.equal(error.message.includes('secret\u0000column'), false);
});

test('normalizes rows while applying shared column, parameter, and payload checks', () => {
  const rows = normalizeDmlRows([
    { id: '900719925474099312345', name: 'Ada' },
    { id: '2', name: null },
  ]);
  assert.deepEqual(rows, [
    { id: '900719925474099312345', name: 'Ada' },
    { id: '2', name: null },
  ]);
  assertError(() => normalizeDmlRows([{ id: Number.MAX_SAFE_INTEGER + 1 }]), 'unsafe_integer', 'rows[0].column');
});
