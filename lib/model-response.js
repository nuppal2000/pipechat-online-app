'use strict';

class ModelResponseError extends Error {
  constructor(code, retryable = false) {
    super('The AI provider did not return a complete structured response.');
    this.name = 'ModelResponseError';
    this.code = code;
    this.retryable = retryable;
    this.status = 502;
  }
}

function parse(response, data) {
  if (!response.ok) throw new ModelResponseError('http_error');
  if (data?.error) throw new ModelResponseError('provider_error');
  const output = Array.isArray(data?.output) ? data.output : [];
  const content = output.flatMap(item => Array.isArray(item?.content) ? item.content : []);
  if (content.some(item => item.type === 'refusal')) throw new ModelResponseError('refusal');
  if (data?.status === 'incomplete') {
    const exhausted = data.incomplete_details?.reason === 'max_output_tokens';
    throw new ModelResponseError(exhausted ? 'output_limit' : 'incomplete', exhausted);
  }
  if (data?.status && data.status !== 'completed') throw new ModelResponseError('not_completed');
  // output_text supports SDK responses; REST returns text inside output message items.
  const text = typeof data?.output_text === 'string' ? data.output_text :
    content.filter(item => ['output_text', 'text'].includes(item.type) && typeof item.text === 'string')
      .map(item => item.text).join('');
  if (!text.trim()) throw new ModelResponseError('empty_output', true);
  let value;
  try { value = JSON.parse(text); }
  catch { throw new ModelResponseError('invalid_json', true); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ModelResponseError('invalid_json', true);
  return value;
}

function takeFallback(error, payload, model, models, startedAt, now = Date.now()) {
  if (!(error instanceof ModelResponseError) || !error.retryable ||
      model !== models.simple || model === models.complex ||
      payload._completionFallbackUsed || now - startedAt >= 65000) return false;
  payload._completionFallbackUsed = true;
  return true;
}

module.exports = { ModelResponseError, parse, takeFallback };
