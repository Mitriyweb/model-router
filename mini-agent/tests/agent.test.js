'use strict';

const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const { test, describe, before, after } = require('node:test');
const fs = require('node:fs/promises');

const { registry } = require('../agent/tools.js');
const { createProvider } = require('../agent/llm.js');
const { openWorkspace, workspace } = require('../agent/workspace.js');
const { parseArgs } = require('../start.js');

describe('mini-agent tests', () => {
  let tempDir;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-agent-test-'));
    await fs.writeFile(path.join(tempDir, 'sample.txt'), 'Hello mini-agent!');
    await openWorkspace(tempDir);
  });

  after(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('tools.js registry loads expected tools', () => {
    assert.ok(registry instanceof Map, 'registry should be a Map');
    const expectedTools = ['read', 'write', 'edit', 'bash', 'glob', 'grep', 'delete', 'patch', 'check', 'fetch', 'todo'];
    for (const toolName of expectedTools) {
      assert.ok(registry.has(toolName), `Registry missing tool: ${toolName}`);
      const tool = registry.get(toolName);
      assert.strictEqual(typeof tool.execute, 'function', `${toolName} should have execute function`);
      assert.ok(tool.definition, `${toolName} should have tool definition`);
    }
  });

  test('workspace.js resolves paths inside workspace and blocks escapes', async () => {
    const resolved = await workspace.resolveExistingFile('sample.txt');
    assert.strictEqual(resolved, path.join(tempDir, 'sample.txt'));

    await assert.rejects(
      async () => {
        await workspace.resolveExistingFile('../outside.txt');
      },
      /Path escapes workspace/,
      'Should reject paths escaping workspace',
    );
  });

  test('llm.js defaults to model-router configuration', () => {
    const provider = createProvider();
    assert.strictEqual(provider.model, 'model-router-auto');
    assert.strictEqual(provider.baseURL, 'http://localhost:8787/v1');
    assert.strictEqual(provider.apiKey, 'dummy');
  });

  test('llm.js respects custom options and environment variables', () => {
    const provider = createProvider({
      model: 'claude-3-5-sonnet',
      baseURL: 'http://localhost:9999/v1',
      apiKey: 'custom-key',
    });
    assert.strictEqual(provider.model, 'claude-3-5-sonnet');
    assert.strictEqual(provider.baseURL, 'http://localhost:9999/v1');
    assert.strictEqual(provider.apiKey, 'custom-key');
  });

  test('start.js parseArgs correctly parses flags and arguments', () => {
    const parsed = parseArgs(['node', 'start.js', '-y', '--dir', '/tmp', '--model', 'codestral-latest', 'Refactor code']);
    assert.strictEqual(parsed.autoApprove, true);
    assert.strictEqual(parsed.workspaceDir, '/tmp');
    assert.strictEqual(parsed.customModel, 'codestral-latest');
    assert.strictEqual(parsed.task, 'Refactor code');
  });
});
