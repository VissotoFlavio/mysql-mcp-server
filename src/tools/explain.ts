import type { McpServer } from '@modelcontextprotocol/server';

import type { ConnectionLayer } from '../db/pool.js';

import { registerBoundedSelectTool } from './query.js';

export function registerExplainQueryTool(server: McpServer, mysql: ConnectionLayer): void {
  registerBoundedSelectTool(server, mysql, {
    name: 'explain_read_only_query',
    title: 'Explain a bounded read-only query',
    description:
      'Returns a bounded MySQL EXPLAIN plan for one approved SELECT query with driver-bound parameters and a configured timeout. This tool is read-only.',
    mode: 'explain',
    executionFailureMessage: 'Unable to explain the query. Verify the configured MySQL connection and query parameters.',
  });
}
