(function attachBackgroundGrokPublisherGrok2Api(root, factory) {
  root.MultiPageBackgroundGrokPublisherGrok2Api = factory(root);
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundGrokPublisherGrok2ApiModule(root) {
  const grokStateApi = root?.MultiPageBackgroundGrokState || null;
  const LOGIN_PATH = '/api/admin/v1/auth/login';
  const IMPORT_PATH = '/api/admin/v1/accounts/web/import';

  function cleanString(value = '') {
    return String(value ?? '').trim();
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function getErrorMessage(error) {
    return error instanceof Error ? error.message : cleanString(error) || '未知错误';
  }

  function normalizeGrok2ApiBaseUrl(value = '') {
    const rawUrl = cleanString(value);
    if (!rawUrl) {
      throw new Error('缺少 Grok2API 地址。');
    }
    const withProtocol = /^https?:\/\//i.test(rawUrl) ? rawUrl : `http://${rawUrl}`;
    let parsed = null;
    try {
      parsed = new URL(withProtocol);
    } catch (_error) {
      throw new Error('Grok2API 地址格式无效，请检查配置。');
    }
    if (!/^https?:$/.test(parsed.protocol)) {
      throw new Error('Grok2API 地址只支持 http 或 https。');
    }
    return parsed.origin;
  }

  function resolveGrok2ApiConfig(state = {}) {
    const config = state?.settingsState?.flows?.grok?.targets?.grok2api || {};
    return {
      baseUrl: cleanString(config.baseUrl || state?.grok2ApiUrl),
      username: cleanString(config.username || state?.grok2ApiUsername),
      password: cleanString(config.password ?? state?.grok2ApiPassword ?? ''),
    };
  }

  function resolveGrokRuntime(state = {}) {
    return grokStateApi?.ensureRuntimeState?.(state)
      || state?.runtimeState?.flowState?.grok
      || state?.flowState?.grok
      || {};
  }

  function resolveGrokSsoCookie(state = {}) {
    return cleanString(resolveGrokRuntime(state)?.sso?.currentCookie || state?.grokSsoCookie);
  }

  function parseSseEvents(raw = '') {
    const events = [];
    String(raw || '').replace(/\r\n/g, '\n').split(/\n\n+/).forEach((block) => {
      const lines = block.split('\n');
      const event = cleanString(lines.find((line) => line.startsWith('event:'))?.slice(6));
      const dataText = lines.filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (!event && !dataText) return;
      let data = null;
      try {
        data = dataText ? JSON.parse(dataText) : null;
      } catch (_error) {
        data = null;
      }
      events.push({ event, data, dataText });
    });
    return events;
  }

  function buildImportPayload(state = {}, ssoToken = '') {
    const runtime = resolveGrokRuntime(state);
    const email = cleanString(runtime?.register?.email || state?.grokEmail).toLowerCase();
    const firstName = cleanString(runtime?.register?.firstName || state?.grokFirstName);
    const lastName = cleanString(runtime?.register?.lastName || state?.grokLastName);
    return {
      provider: 'grok_web',
      accounts: [{
        name: cleanString([firstName, lastName].filter(Boolean).join(' ')) || email || 'FlowPilot Grok',
        email,
        sso_token: cleanString(ssoToken),
        tier: 'auto',
      }],
    };
  }

  function buildRuntimePatch(currentState = {}, upload = {}, lastError = '') {
    const runtime = resolveGrokRuntime(currentState);
    const uploads = isPlainObject(runtime.uploads) ? runtime.uploads : {};
    const patch = {
      session: { lastError: cleanString(lastError) },
      uploads: { ...uploads, grok2api: upload },
    };
    return grokStateApi?.buildRuntimeStatePatch?.(currentState, patch) || {
      runtimeState: {
        ...(currentState.runtimeState || {}),
        flowState: {
          ...(currentState.runtimeState?.flowState || {}),
          grok: { ...runtime, ...patch },
        },
      },
    };
  }

  async function readResponse(response) {
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_error) { json = null; }
    return { text, json };
  }

  async function loginGrok2Api(baseUrl, username, password, fetchImpl) {
    const response = await fetchImpl(`${normalizeGrok2ApiBaseUrl(baseUrl)}${LOGIN_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const body = await readResponse(response);
    const accessToken = cleanString(body.json?.data?.tokens?.accessToken);
    if (!response.ok || !accessToken) {
      const message = cleanString(body.json?.error?.message || body.json?.message || response.statusText) || `HTTP ${response.status}`;
      throw new Error(`Grok2API 管理员登录失败：${message}`);
    }
    return accessToken;
  }

  async function importGrokAccount(baseUrl, accessToken, payload, fetchImpl) {
    const form = new FormData();
    form.append('files', new Blob([JSON.stringify(payload)], { type: 'application/json' }), 'grok-account.json');
    const response = await fetchImpl(`${normalizeGrok2ApiBaseUrl(baseUrl)}${IMPORT_PATH}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'text/event-stream' },
      body: form,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Grok2API 账号导入失败：HTTP ${response.status}`);
    }
    const events = parseSseEvents(text);
    const failure = events.find((entry) => entry.event === 'error');
    if (failure) {
      throw new Error(`Grok2API 账号导入失败：${cleanString(failure.data?.message || failure.data?.code) || '服务端返回错误'}`);
    }
    const complete = events.filter((entry) => entry.event === 'complete').at(-1)?.data;
    if (!isPlainObject(complete)) {
      throw new Error('Grok2API 账号导入失败：未收到完成事件。');
    }
    if (Number(complete.syncFailed || 0) > 0) {
      throw new Error('Grok2API 账号导入失败：部分账号同步失败。');
    }
    return complete;
  }

  function createGrok2ApiPublisher(deps = {}) {
    const {
      addLog = async () => {},
      completeNodeFromBackground,
      fetchImpl = typeof fetch === 'function' ? fetch.bind(globalThis) : null,
      getState = async () => ({}),
      setState = async () => {},
    } = deps;
    if (typeof completeNodeFromBackground !== 'function' || typeof fetchImpl !== 'function') {
      throw new Error('Grok2API publisher requires background completion and fetch support.');
    }

    async function executeGrokUploadSsoToGrok2Api(state = {}) {
      const nodeId = cleanString(state.nodeId) || 'grok-upload-sso-to-grok2api';
      const currentState = await getState();
      let targetUrl = '';
      try {
        const config = resolveGrok2ApiConfig(currentState);
        if (!config.username || !config.password) throw new Error('缺少 Grok2API 管理员用户名或密码。');
        const ssoToken = resolveGrokSsoCookie(currentState);
        if (!ssoToken) throw new Error('缺少 Grok SSO Cookie，请先完成步骤 5。');
        targetUrl = normalizeGrok2ApiBaseUrl(config.baseUrl);
        await setState(buildRuntimePatch(currentState, { status: 'uploading', uploadedAt: 0, message: '', targetUrl }, ''));
        await addLog('步骤 6：正在导入 Grok 账号到 Grok2API...', 'info', { nodeId });
        const accessToken = await loginGrok2Api(config.baseUrl, config.username, config.password, fetchImpl);
        const complete = await importGrokAccount(config.baseUrl, accessToken, buildImportPayload(currentState, ssoToken), fetchImpl);
        const message = `导入完成：新增 ${Number(complete.created || 0)}，更新 ${Number(complete.updated || 0)}。`;
        const payload = buildRuntimePatch(currentState, { status: 'uploaded', uploadedAt: Date.now(), message, targetUrl, created: Number(complete.created || 0), updated: Number(complete.updated || 0) }, '');
        await setState(payload);
        await addLog(`步骤 6：${message}`, 'ok', { nodeId });
        await completeNodeFromBackground(nodeId, payload);
      } catch (error) {
        const message = getErrorMessage(error);
        await setState(buildRuntimePatch(currentState, { status: 'error', uploadedAt: 0, message, targetUrl }, message));
        await addLog(`步骤 6：${message}`, 'error', { nodeId });
        throw error;
      }
    }

    return { executeGrokUploadSsoToGrok2Api };
  }

  return { buildImportPayload, createGrok2ApiPublisher, importGrokAccount, loginGrok2Api, normalizeGrok2ApiBaseUrl, parseSseEvents };
});
