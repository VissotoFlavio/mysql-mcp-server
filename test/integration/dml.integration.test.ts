import test from 'node:test';

const enabled = process.env.MYSQL_INTEGRATION_TEST === 'true' && process.env.MYSQL_DML_INTEGRATION_TEST === 'true';

test('DML integration tests require explicit opt-in and an isolated database', { skip: !enabled }, () => {
  throw new Error(
    'DML integration tests are a safety placeholder: implement the isolated schema/table contract before enabling them. They must never run against shared or production data.',
  );
});
