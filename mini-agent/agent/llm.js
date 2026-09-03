'use strict';

const path = require('node:path');
const { delay } = require('metautil');
const OpenAI = require('openai');
const concolor = require('concolor');

const getConfig = () => {
  try {
    return require('../config.js');
  } catch {
    return require('./config.template.js');
  }
};

const color = concolor({
  warn: 'b,yellow',
});

const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;
const RETRY_STATUSES = [429, 503];
const RETRY_MARKERS = ['UNAVAILABLE', 'high demand'];

const isRetryable = (error) => {
  if (RETRY_STATUSES.includes(error?.status)) return true;
  const message = error?.message;
  const text = typeof message === 'string' ? message : '';
  return RETRY_MARKERS.some((marker) => text.includes(marker));
};

const unique = (values) => {
  const isString = (value) => typeof value === 'string' && value !== '';
  const present = values.filter(isString);
  return [...new Set(present)];
};

const requireText = (value, name) => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text) return text;
  throw new Error(`${name} is not set. Set it in config.js or environment variable.`);
};

const createWithRetry = async (client, body, models, log) => {
  let lastError;

  for (let index = 0; index < models.length; index += 1) {
    const model = models[index];
    const nextModel = models[index + 1];
    const request = { ...body, model };

    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
      try {
        const response = await client.chat.completions.create(request);
        return { response, model };
      } catch (error) {
        lastError = error;
        if (!isRetryable(error)) throw error;
        const status = error.status ?? 503;
        const lastAttempt = attempt === RETRY_ATTEMPTS;
        if (nextModel && (lastAttempt || status === 503)) {
          const fromTo = `${model} → ${nextModel}`;
          const notice = `model busy (${status}); switching ${fromTo}`;
          log(color.warn(notice));
          break;
        }
        if (lastAttempt) throw error;
        const wait = RETRY_DELAY_MS * attempt;
        const seconds = wait / 1000;
        const retry = `${attempt}/${RETRY_ATTEMPTS - 1}`;
        const notice = `model busy (${status}); retry ${retry} in ${seconds}s`;
        log(color.warn(notice));
        await delay(wait);
      }
    }
  }

  throw lastError ?? new Error('Model request failed after retries.');
};

const createProvider = (options = {}) => {
  const config = getConfig();
  const apiKey = requireText(
    options.apiKey ?? process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? config.API_KEY ?? 'dummy',
    'API_KEY',
  );
  let model = requireText(
    options.model ?? process.env.MODEL ?? config.MODEL ?? 'model-router-auto',
    'MODEL',
  );
  const baseURL = requireText(
    options.baseURL ?? process.env.OPENAI_BASE_URL ?? config.BASE_URL ?? 'http://localhost:8787/v1',
    'BASE_URL',
  );
  const fallbacks = options.fallbacks ?? config.FALLBACK_MODELS ?? [];
  const log = options.log ?? console.log;

  const client = new OpenAI({ apiKey, baseURL });

  return {
    get model() {
      return model;
    },
    get baseURL() {
      return baseURL;
    },
    get apiKey() {
      return apiKey;
    },
    async respond(request) {
      const messages = request.messages;
      const tools = request.tools;
      const body = { model, messages, tools, tool_choice: 'auto' };
      const models = unique([model, ...fallbacks]);
      const result = await createWithRetry(client, body, models, log);
      model = result.model;
      return result.response;
    },
  };
};

module.exports = { createProvider };
