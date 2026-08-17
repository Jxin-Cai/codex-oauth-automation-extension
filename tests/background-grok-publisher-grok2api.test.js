const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function loadPublisherApi() {
  const stateSource = fs.readFileSync('flows/grok/background/state.js', 'utf8');
  const publisherSource = fs.readFileSync('flows/grok/background/publisher-grok2api.js', 'utf8');
  const globalScope = {};
  new Function('self', `${stateSource}; ${publisherSource}; return self;`)(globalScope);
  return globalScope.MultiPageBackgroundGrokPublisherGrok2Api;
}

function createTextResponse(text, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? 'OK' : 'Error',
    text: async () => text,
  };
}

function createJsonResponse(payload, status = 200) {
  return createTextResponse(JSON.stringify(payload), status);
}

function getGrokRuntime(state = {}) {
  return state?.runtimeState?.flowState?.grok || {};
}

test('grok2api publisher normalizes host and builds grok_web import payload', () => {
  const api = loadPublisherApi();
  assert.equal(typeof api?.createGrok2ApiPublisher, 'function');
  assert.equal(api.normalizeGrok2ApiBaseUrl('https://grok2api.example.com/admin/'), 'https://grok2api.example.com');
  assert.equal(api.normalizeGrok2ApiBaseUrl('127.0.0.1:9000'), 'http://127.0.0.1:9000');
  const payload = api.buildImportPayload({
    grokEmail: 'USER@EXAMPLE.COM',
    grokFirstName: 'Ada',
    grokLastName: 'Lovelace',
  }, 'sso-token-001');
  assert.equal(payload.provider, 'grok_web');
  assert.equal(payload.accounts[0].email, 'user@example.com');
  assert.equal(payload.accounts[0].sso_token, 'sso-token-001');
  assert.equal(payload.accounts[0].tier, 'auto');
});

test('grok2api publisher logs in then imports via multipart SSE without leaking secrets', async () => {
  const api = loadPublisherApi();
  const requests = [];
  const logs = [];
  const completed = [];
  let currentState = {
    grokSsoCookie: 'live-sso-cookie',
    grokEmail: 'user@example.com',
    grokFirstName: 'Ada',
    grokLastName: 'Lovelace',
    settingsState: {
      flows: {
        grok: {
          targets: {
            grok2api: {
              baseUrl: 'https://grok2api.example.com/admin',
              username: 'admin',
              password: 'super-secret-password',
            },
          },
        },
      },
    },
  };

  const publisher = api.createGrok2ApiPublisher({
    addLog: async (message, level) => logs.push({ message, level }),
    completeNodeFromBackground: async (nodeId, payload) => completed.push({ nodeId, payload }),
    getState: async () => currentState,
    setState: async (patch) => {
      currentState = { ...currentState, ...patch };
    },
    fetchImpl: async (url, options = {}) => {
      requests.push({
        url,
        method: options.method,
        authorization: options.headers?.Authorization || '',
        contentType: options.headers?.['Content-Type'] || '',
        accept: options.headers?.Accept || '',
        body: options.body,
      });
      if (String(url).endsWith('/api/admin/v1/auth/login')) {
        return createJsonResponse({
          data: {
            tokens: { accessToken: 'access-token-secret' },
          },
        });
      }
      return createTextResponse([
        'event: progress',
        'data: {"completed":1,"total":1,"phase":"importing"}',
        '',
        'event: complete',
        'data: {"created":1,"updated":0,"synced":1,"syncFailed":0}',
        '',
      ].join('\n'));
    },
  });

  await publisher.executeGrokUploadSsoToGrok2Api({ nodeId: 'grok-upload-sso-to-grok2api' });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://grok2api.example.com/api/admin/v1/auth/login');
  assert.equal(requests[1].url, 'https://grok2api.example.com/api/admin/v1/accounts/web/import');
  assert.match(requests[1].authorization, /^Bearer access-token-secret$/);
  assert.equal(requests[1].accept, 'text/event-stream');
  assert.equal(completed.length, 1);
  assert.equal(getGrokRuntime(completed[0].payload).uploads.grok2api.status, 'uploaded');
  assert.match(getGrokRuntime(completed[0].payload).uploads.grok2api.message, /新增 1/);
  const serialized = JSON.stringify({ logs, completed });
  assert.doesNotMatch(serialized, /super-secret-password/);
  assert.doesNotMatch(serialized, /access-token-secret/);
  assert.doesNotMatch(logs.map((entry) => entry.message).join('\n'), /live-sso-cookie/);
});

test('grok2api publisher treats SSE error and syncFailed as upload failures', async () => {
  const api = loadPublisherApi();
  const publisher = api.createGrok2ApiPublisher({
    addLog: async () => {},
    completeNodeFromBackground: async () => {
      throw new Error('should not complete');
    },
    getState: async () => ({
      grokSsoCookie: 'sso-cookie',
      grok2ApiUrl: 'https://grok2api.example.com',
      grok2ApiUsername: 'admin',
      grok2ApiPassword: 'secret',
    }),
    setState: async () => {},
    fetchImpl: async (url) => {
      if (String(url).endsWith('/auth/login')) {
        return createJsonResponse({ data: { tokens: { accessToken: 'token' } } });
      }
      return createTextResponse([
        'event: error',
        'data: {"code":"authImportFailed","message":"导入账号失败"}',
        '',
      ].join('\n'));
    },
  });

  await assert.rejects(
    () => publisher.executeGrokUploadSsoToGrok2Api({ nodeId: 'grok-upload-sso-to-grok2api' }),
    /导入账号失败/
  );
});
