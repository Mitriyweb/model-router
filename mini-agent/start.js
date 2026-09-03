#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');

const concolor = require('concolor');
const { directoryExists, exists } = require('metautil');

const color = concolor({
  info: 'b,blue',
  warn: 'b,yellow',
  error: 'b,red',
  success: 'b,green',
  cyan: 'b,cyan',
  dim: 'gray',
});

const { errorText, runAgent } = require('./agent/agent.js');
const { createProvider } = require('./agent/llm.js');
const { createPermissions } = require('./agent/permissions.js');
const { openWorkspace } = require('./agent/workspace.js');

const DEFAULT_MAX_STEPS = 30;

const parseArgs = (argv) => {
  const args = argv.slice(2);
  let autoApprove = process.env.AUTO_APPROVE === 'true';
  let workspaceDir = process.cwd();
  let customModel = process.env.MODEL;
  let customUrl = process.env.OPENAI_BASE_URL;
  const taskParts = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-y' || arg === '--auto-approve' || arg === '--yes') {
      autoApprove = true;
    } else if (arg === '--dir' && i + 1 < args.length) {
      workspaceDir = args[++i];
    } else if (arg === '--model' && i + 1 < args.length) {
      customModel = args[++i];
    } else if (arg === '--url' && i + 1 < args.length) {
      customUrl = args[++i];
    } else if (!arg.startsWith('-') && taskParts.length === 0 && fs.existsSync(path.resolve(arg)) && fs.statSync(path.resolve(arg)).isDirectory()) {
      workspaceDir = arg;
    } else {
      taskParts.push(arg);
    }
  }

  const task = taskParts.join(' ').trim();
  return { autoApprove, workspaceDir, customModel, customUrl, task };
};

const resolveRoot = async (dirPath) => {
  const root = path.resolve(dirPath || process.cwd());
  const found = await exists(root);
  if (!found) throw new Error(`Workspace path not found: ${root}`);
  const isDir = await directoryExists(root);
  if (!isDir) throw new Error(`Workspace path is not a directory: ${root}`);
  return root;
};

const createEventHandler = () => {
  return async (event) => {
    switch (event.type) {
      case 'step':
        console.log(color.info(`\n[Step ${event.step}/${event.maxSteps}] Using model: ${event.model}`));
        break;
      case 'tool':
        console.log(color.cyan(`⚡ Tool Call: ${event.name}`));
        if (event.argsText && event.argsText !== '{}') {
          console.log(color.dim(`   Arguments: ${event.argsText}`));
        }
        break;
      case 'result': {
        const badge = event.status === 'ok' ? color.success('✔') : color.error('✖');
        console.log(`${badge} Tool Result (${event.name}): status=${event.status}`);
        if (event.preview) {
          const lines = event.preview.split('\n').slice(0, 5).join('\n');
          console.log(color.dim(`   Output:\n${lines}`));
        }
        break;
      }
      case 'assistant':
        console.log(color.success('\n🤖 Assistant:'));
        console.log(event.text);
        break;
    }
  };
};

const main = async () => {
  const options = parseArgs(process.argv);
  const root = await resolveRoot(options.workspaceDir);
  await openWorkspace(root);

  const providerOptions = {};
  if (options.customModel) providerOptions.model = options.customModel;
  if (options.customUrl) providerOptions.baseURL = options.customUrl;

  const provider = createProvider(providerOptions);
  const permissions = createPermissions({ autoApprove: options.autoApprove });

  console.log(color.info('=================================================='));
  console.log(color.info('           mini-agent (model-router)             '));
  console.log(color.info('=================================================='));
  console.log(`Workspace : ${root}`);
  console.log(`Base URL  : ${provider.baseURL}`);
  console.log(`Model     : ${provider.model}`);
  console.log(`AutoApprove: ${options.autoApprove ? 'YES' : 'NO'}`);
  console.log('--------------------------------------------------\n');

  const onEvent = createEventHandler();

  if (options.task) {
    console.log(color.cyan(`Task: ${options.task}\n`));
    try {
      await runAgent({
        task: options.task,
        provider,
        permissions,
        maxSteps: DEFAULT_MAX_STEPS,
        onEvent,
      });
      console.log(color.success('\nTask completed successfully.'));
    } catch (err) {
      console.error(color.error(`\nAgent error: ${errorText(err)}`));
      process.exitCode = 1;
    } finally {
      permissions.close();
    }
    return;
  }

  // Interactive REPL mode
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let priorMessages = null;

  console.log(color.info('Interactive session started. Type your task below or "exit" / "quit" to stop.\n'));

  try {
    while (true) {
      const taskInput = await rl.question(color.cyan('mini-agent > '));
      const trimmed = taskInput.trim();
      if (!trimmed) continue;
      if (trimmed.toLowerCase() === 'exit' || trimmed.toLowerCase() === 'quit') {
        console.log('Goodbye!');
        break;
      }

      try {
        const result = await runAgent({
          task: trimmed,
          provider,
          permissions,
          maxSteps: DEFAULT_MAX_STEPS,
          onEvent,
          priorMessages,
        });
        priorMessages = result.messages;
      } catch (err) {
        console.error(color.error(`\nAgent error: ${errorText(err)}`));
      }
      console.log('\n--------------------------------------------------');
    }
  } finally {
    rl.close();
    permissions.close();
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error(color.error(`\nFatal error: ${errorText(error)}`));
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, resolveRoot, main };
