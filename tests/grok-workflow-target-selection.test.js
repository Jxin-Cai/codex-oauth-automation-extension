const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function loadWorkflowApi() {
  const source = fs.readFileSync('flows/grok/workflow.js', 'utf8');
  const globalScope = {};
  return new Function('self', `${source}; return self.MultiPageGrokWorkflow;`)(globalScope);
}

test('grok workflow returns a single target-specific upload step', () => {
  const api = loadWorkflowApi();
  const webchatSteps = api.getModeStepDefinitions({ targetId: 'webchat2api' });
  const grok2ApiSteps = api.getModeStepDefinitions({ targetId: 'grok2api' });
  const fallbackSteps = api.getModeStepDefinitions({ targetId: 'unknown' });

  assert.deepEqual(webchatSteps.map((step) => step.key).slice(-1), ['grok-upload-sso-to-webchat2api']);
  assert.deepEqual(grok2ApiSteps.map((step) => step.key).slice(-1), ['grok-upload-sso-to-grok2api']);
  assert.deepEqual(fallbackSteps.map((step) => step.key).slice(-1), ['grok-upload-sso-to-webchat2api']);
  assert.equal(webchatSteps.filter((step) => String(step.key).includes('upload')).length, 1);
  assert.equal(grok2ApiSteps.filter((step) => String(step.key).includes('upload')).length, 1);
  assert.equal(webchatSteps.at(-1).id, 6);
  assert.equal(grok2ApiSteps.at(-1).id, 6);
  assert.deepEqual(webchatSteps.slice(0, 5).map((step) => step.key), grok2ApiSteps.slice(0, 5).map((step) => step.key));
});
