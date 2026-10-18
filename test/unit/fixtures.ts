import { randomUUID } from 'node:crypto';

import type { Environment } from '../../src/config.js';

export function validEnvironment(overrides: Environment = {}): Environment {
  const token = randomUUID().replaceAll('-', '');

  return {
    MYSQL_HOST: `host-${token}.invalid`,
    MYSQL_DATABASE: `database_${token}`,
    MYSQL_USER: `user_${token}`,
    MYSQL_PASSWORD: randomUUID(),
    ...overrides,
  };
}
