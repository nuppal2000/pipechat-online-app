// Synthetic provider only. Never sends an external network request.
const assert = require('node:assert/strict');
global.fetch = async (url, options) => {
  assert.equal(String(url), 'https://api.openai.com/v1/responses');
  const input = JSON.parse(JSON.parse(options.body).input[0].content[0].text);
  if (input.userCommand === 'throw-provider-canary') {
    throw new Error('PRIVATE_PROVIDER_EXCEPTION_CANARY');
  }
  return { ok: false, status: 429, json: async () => ({
    error: { message: 'PRIVATE_PROVIDER_RESPONSE_CANARY' }
  }) };
};
