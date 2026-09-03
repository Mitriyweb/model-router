'use strict';

module.exports = {
  // Model Router endpoint or any OpenAI-compatible API.
  API_KEY: process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || 'dummy',
  BASE_URL: process.env.OPENAI_BASE_URL || 'http://localhost:8787/v1',
  MODEL: process.env.MODEL || 'model-router-auto',
  FALLBACK_MODELS: [],
};
