/* global URL, clearTimeout, console, process, setTimeout */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const requiredReadOnlyTools = [
  'list_accessible_schemas',
  'list_accessible_tables',
  'describe_table',
  'execute_read_only_query',
  'explain_read_only_query',
];

function parseEnvironmentTemplate(template) {
  const environment = {};
  for (const line of template.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    assert.notEqual(separator, -1, `Invalid environment assignment: ${line}`);
    environment[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  return environment;
}

function runChecked(command, args, options = {}) {
  const useWindowsShell = process.platform === 'win32';
  const commandLine = useWindowsShell ? [command, ...args].map(quoteWindowsArgument).join(' ') : command;
  const result = spawnSync(commandLine, useWindowsShell ? [] : args, {
    ...options,
    encoding: 'utf8',
    shell: useWindowsShell,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed:\n${result.stderr}`);
  return result.stdout;
}

function quoteWindowsArgument(value) {
  if (!/[\s"]/u.test(value)) return value;
  return `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1')}"`;
}

function parsePackResult(output) {
  for (let jsonStart = output.lastIndexOf('['); jsonStart >= 0; jsonStart = output.lastIndexOf('[', jsonStart - 1)) {
    try {
      const [result] = JSON.parse(output.slice(jsonStart));
      if (result?.filename) return result;
    } catch {
      // npm may print lifecycle output before its final JSON document.
    }
  }
  throw new Error('npm pack did not return JSON metadata.');
}

function readStdioMessage(child) {
  const readline = createInterface({ input: child.stdout });
  const queuedLines = [];
  let pending;

  readline.on('line', (line) => {
    if (pending === undefined) {
      queuedLines.push(line);
      return;
    }
    const resolvePending = pending;
    pending = undefined;
    resolvePending(line);
  });

  const nextLine = () => {
    if (queuedLines.length > 0) return Promise.resolve(queuedLines.shift());
    return new Promise((resolveLine, reject) => {
      const timeout = setTimeout(() => {
        pending = undefined;
        reject(new Error('Timed out waiting for an MCP stdio response.'));
      }, 5_000);
      pending = (line) => {
        clearTimeout(timeout);
        resolveLine(line);
      };
    });
  };

  return {
    async request(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
      const line = await nextLine();
      assert.notEqual(line.trim(), '', 'The MCP process emitted an empty stdout line.');
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`The MCP process emitted non-JSON stdout: ${line}`, { cause: error });
      }
    },
    close() {
      readline.close();
    },
  };
}

async function waitForExit(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', resolveExit);
  });
}

async function main() {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'mysql-mcp-package-smoke-'));
  const npmEnvironment = { ...process.env, npm_config_cache: join(temporaryRoot, 'npm-cache') };
  let child;
  let messageReader;

  try {
    const packOutput = runChecked(npmExecutable, ['pack', '--json', '--pack-destination', temporaryRoot], {
      cwd: repositoryRoot,
      env: npmEnvironment,
    });
    const packageMetadata = parsePackResult(packOutput);
    const packageFile = join(temporaryRoot, packageMetadata.filename);
    const installDirectory = join(temporaryRoot, 'installed package');

    runChecked(npmExecutable, ['install', '--omit=dev', '--prefix', installDirectory, packageFile], {
      cwd: repositoryRoot,
      env: npmEnvironment,
    });

    const installedPackageRoot = join(installDirectory, 'node_modules', 'mysql-mcp-server');
    const installedReadme = await readFile(join(installedPackageRoot, 'README.md'), 'utf8');
    assert.match(installedReadme, /assets\/illustration\.png/u, 'The installed README must reference the packaged illustration.');
    await access(join(installedPackageRoot, 'assets', 'illustration.png'));
    const template = await readFile(join(installedPackageRoot, '.env.example'), 'utf8');
    const environment = parseEnvironmentTemplate(template);
    assert.deepEqual(
      Object.entries(environment)
        .filter(([, value]) => value.length === 0)
        .map(([name]) => name),
      ['MYSQL_HOST', 'MYSQL_DATABASE', 'MYSQL_USER', 'MYSQL_PASSWORD'],
    );

    Object.assign(environment, {
      MYSQL_HOST: 'mysql.example.test',
      MYSQL_DATABASE: 'demo_catalog',
      MYSQL_USER: 'mcp_reader',
      MYSQL_PASSWORD: 'synthetic-password',
    });
    const environmentFile = join(installDirectory, '.env');
    await writeFile(
      environmentFile,
      `${Object.entries(environment)
        .map(([name, value]) => `${name}=${value}`)
        .join('\n')}\n`,
    );

    child = spawn(process.execPath, [`--env-file=${environmentFile}`, join(installedPackageRoot, 'dist', 'server.js')], {
      cwd: installDirectory,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stderr = [];
    child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
    messageReader = readStdioMessage(child);

    const initializeResponse = await messageReader.request({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'mysql-mcp-package-smoke', version: '1.0.0' },
      },
    });
    assert.equal(initializeResponse.error, undefined, JSON.stringify(initializeResponse));
    assert.ok(initializeResponse.result, 'The installed MCP process did not complete initialize.');

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
    const toolsResponse = await messageReader.request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.equal(toolsResponse.error, undefined, JSON.stringify(toolsResponse));
    const toolNames = toolsResponse.result?.tools?.map(({ name }) => name).sort();
    assert.deepEqual(toolNames, [...requiredReadOnlyTools].sort());

    child.stdin.end();
    await waitForExit(child);
    assert.equal(child.exitCode, 0, `The installed MCP process exited with code ${child.exitCode}: ${stderr.join('')}`);
    console.log('Package smoke passed: installed .tgz handshake exposes five read-only tools.');
  } finally {
    messageReader?.close();
    if (child?.exitCode === null) child.kill();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await main();
