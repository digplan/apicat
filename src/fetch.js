import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseYaml } from './yaml.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const defaultLocalConfigPath = () => join(process.cwd(), '.apicat');
export const defaultUserConfigPath = () => join(homedir(), '.apicat');
export const defaultLocalYamlConfigPath = () => join(process.cwd(), 'apicat.yaml');
export const defaultBundledConfigPath = join(root, 'apicat.yaml');

export const isReadableFile = (path) => {
  if (!path) return false;
  try {
    return fs.statSync(path).isFile();
  } catch {
    return false;
  }
};

const resolveDefaultConfigPath = (opts = {}) => {
  const cwd = opts.cwd ?? process.cwd();
  const local = opts.localConfigPath ?? join(cwd, '.apicat');
  if (isReadableFile(local)) return local;
  const user = opts.userConfigPath ?? join(homedir(), '.apicat');
  if (isReadableFile(user)) return user;
  const bundled = opts.bundledConfigPath ?? defaultBundledConfigPath;
  if (isReadableFile(bundled)) return bundled;
  return null;
};

export const runJq = (q, input) => {
  const filter = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(String(q).trim()) ? `.${q}` : q;
  const r = spawnSync('jq', ['-r', filter], { input, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  if (r.error || r.status) throw new Error(r.stderr || r.error || `jq exited ${r.status}`);
  return r.stdout;
};

const parseId = (id) => {
  const parts = id.split('.');
  const service = parts.shift();
  const name = parts.join('.');
  const segs = name.split('.');
  const last = segs[segs.length - 1];
  const step = /^\d+$/.test(last) ? Number(last) : null;
  const base = step != null ? segs.slice(0, -1).join('.') : name;
  return { id, service, name, base, step };
};

const parseTxt = (c) => {
  const lines = c.trim().split('\n');
  const keys = lines.shift().trim().split(/\s+/);
  return { apis: lines.map(l => {
    const v = []; let cur = '', q = 0;
    for (let i = 0; i < l.length; i++) {
      if (l[i] === '"' && l[i+1] === '"') { cur += '"'; i++; }
      else if (l[i] === '"') q = !q;
      else if (l[i] === ' ' && !q) { v.push(cur); cur = ''; }
      else cur += l[i];
    }
    const row = [...v, cur];
    return Object.fromEntries(keys.map((k, i) => {
      let val = row[i] === 'null' ? null : row[i];
      if (k !== 'body' && val?.startsWith?.('{')) try { val = JSON.parse(val); } catch(e){}
      return [k, val];
    }));
  }) };
};

const isInJsonString = (source, end) => {
  let inString = false;
  let escaped = false;
  for (let i = 0; i < end; i++) {
    if (escaped) escaped = false;
    else if (source[i] === '\\') escaped = true;
    else if (source[i] === '"') inString = !inString;
  }
  return inString;
};

const sub = (s, v = {}, json = false) => s?.replace?.(/(\$\$)|(\$!?)([A-Za-z_]\w*)/g, (_, esc, p, k, offset, source) => {
  if (esc) return '$';
  let val = v[k] ?? process.env[k];
  if (p.includes('!') && val == null) throw new Error(`Variable ${k} is required`);
  if (json && val != null && isInJsonString(source, offset)) return JSON.stringify(String(val)).slice(1, -1);
  return val ?? '';
}) ?? s;

const walk = (obj, v) => {
  if (typeof obj === 'string') return sub(obj, v);
  if (Array.isArray(obj)) return obj.map(x => walk(x, v));
  if (obj && typeof obj === 'object') return Object.fromEntries(Object.entries(obj).map(([k, x]) => [k, walk(x, v)]));
  return obj;
};

const numberOrNull = (value) => {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const parseYamlApis = (content) => {
  const data = parseYaml(content);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  return Object.entries(data).map(([id, api]) => ({ ...parseId(id), ...api }));
};

const loadApisFromFile = (path) => {
  if (!path || !isReadableFile(path)) return [];
  const content = fs.readFileSync(path, 'utf8');
  if (path.endsWith('.txt')) {
    return parseTxt(content).apis.map(a => ({ ...parseId(`${a.service}.${a.name}`), ...a }));
  }
  return parseYamlApis(content);
};

export function getApis(configPath, options = {}) {
  if (typeof configPath === 'string') {
    return loadApisFromFile(configPath);
  }
  const opts = (configPath && typeof configPath === 'object') ? configPath : options;
  const basePath = resolveDefaultConfigPath(opts);
  const baseApis = loadApisFromFile(basePath);

  const cwd = opts.cwd ?? process.cwd();
  const localYamlConfigPath = opts.localYamlConfigPath ?? join(cwd, 'apicat.yaml');
  const hasLocalYaml = isReadableFile(localYamlConfigPath);

  if (!hasLocalYaml || (basePath && localYamlConfigPath === basePath)) {
    return baseApis;
  }

  const localYamlApis = loadApisFromFile(localYamlConfigPath);
  if (!localYamlApis.length) return baseApis;
  if (!baseApis.length) return localYamlApis;

  const map = new Map();
  for (const api of baseApis) {
    map.set(api.id, api);
  }
  for (const api of localYamlApis) {
    map.set(api.id, api);
  }
  return Array.from(map.values());
}

export const getApi = (s, n, p, options) => getApis(p, options).find(a => a.service === s && a.name === n);
export const getFlow = (s, n, p, options) => {
  const all = getApis(p, options).filter(a => a.service === s);
  const base = all.find(a => a.name === n);
  const steps = all.filter(a => a.base === n && a.step != null).sort((a, b) => a.step - b.step);
  return { base, steps };
};

export function getRequest(s, n, vars = {}, p, options = {}) {
  const api = getApi(s, n, p, options);
  if (!api) throw new Error(`Unknown API: ${s}.${n}`);
  const v = { ...vars }, provider = v.PROVIDER ?? process.env.PROVIDER;
  let { url, method, headers, body, file, multipart, output, stream } = api;
  if (options.stream != null) stream = options.stream;
  if (options.noStream) stream = false;
  url = sub(url, v);
  if (typeof headers === 'string' && headers.startsWith('BEARER ')) {
    headers = { Authorization: `Bearer ${sub(headers.slice(7).trim(), v)}`, 'Content-Type': 'application/json' };
  }
  headers = walk(headers, v);
  if (body != null) {
    body = String(body).trim();
    const pb = ', "provider": {"order": ["$PROVIDER"]}';
    body = provider ? body.replace(pb, pb.replace('$PROVIDER', provider)) : body.replace(pb, '');
    body = sub(body, v, true);
    if (stream) {
      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === 'object') {
          if (options.stream || parsed.stream == null) {
            parsed.stream = true;
            body = JSON.stringify(parsed);
          }
        }
      } catch {}
    } else if (options.noStream) {
      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === 'object') {
          parsed.stream = false;
          body = JSON.stringify(parsed);
        }
      } catch {}
    }
  }
  if (stream && headers && typeof headers === 'object') {
    const hasAccept = Object.keys(headers).some(k => k.toLowerCase() === 'accept');
    if (!hasAccept) headers.Accept = 'text/event-stream, application/json, */*';
  }
  file = sub(file, v);
  multipart = walk(multipart, v);
  output = sub(output, v);
  return { url, method, headers, body, file, multipart, output, stream };
}

const getFileBody = (path) => {
  if (!path) return undefined;
  try {
    return fs.readFileSync(path);
  } catch (error) {
    throw new Error(`Unable to read upload file ${path}: ${error.message}`);
  }
};

const getMultipartBody = (fields) => {
  if (!fields || typeof fields !== 'object') return undefined;
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    if (value && typeof value === 'object' && value.file != null) {
      const path = value.file;
      const bytes = getFileBody(path);
      const type = value.content_type || 'application/octet-stream';
      form.append(name, new Blob([bytes], { type }), value.filename || basename(path));
    } else {
      form.append(name, value == null ? '' : String(value));
    }
  }
  return form;
};

const buildWsRequest = (api, vars = {}) => {
  if (!api) throw new Error('Missing API definition');
  let { url, headers, body, keep_alive, reconnect, timeout, capture } = api;
  url = sub(url, vars);
  if (typeof headers === 'string' && headers.startsWith('BEARER ')) {
    headers = { Authorization: `Bearer ${sub(headers.slice(7).trim(), vars)}` };
  }
  headers = walk(headers, vars);
  if (body != null) {
    body = String(body).trim();
    body = sub(body, vars);
  }
  capture = walk(capture, vars);
  return { url, headers, body, keep_alive, reconnect, timeout, capture };
};

const partialMatch = (actual, expected) => {
  if (expected == null || typeof expected !== 'object') return actual === expected;
  if (actual == null || typeof actual !== 'object') return false;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length < expected.length) return false;
    return expected.every((value, index) => partialMatch(actual[index], value));
  }
  return Object.entries(expected).every(([key, value]) => partialMatch(actual[key], value));
};

export const matchesExpectation = (message, expect) => {
  if (expect == null) return true;
  return partialMatch(message, expect);
};

const resolveWsValue = (value, vars = {}) => {
  if (typeof value === 'string') {
    const exact = value.match(/^\$(!?)([A-Za-z_]\w*)$/);
    if (exact) {
      const val = vars[exact[2]] ?? process.env[exact[2]];
      if (exact[1] && val == null) throw new Error(`Variable ${exact[2]} is required`);
      return val ?? null;
    }
    return sub(value, vars);
  }
  if (Array.isArray(value)) return value.map(item => resolveWsValue(item, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveWsValue(v, vars)]));
  return value;
};

const wsPayload = (value) => {
  if (value == null) return '';
  if (typeof value === 'string' || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
  return JSON.stringify(value);
};

const isKeepAliveConfig = (keepAlive) => keepAlive && typeof keepAlive === 'object';

const isLongLivedWs = (flow) => flow.some(api => api?.keep_alive || api?.reconnect?.enabled);

const reconnectConfig = (flow) => {
  const configured = flow.find(api => api?.reconnect)?.reconnect;
  if (!configured?.enabled) return null;
  return {
    enabled: true,
    initial: numberOrNull(configured.initial) ?? 1,
    maximum: numberOrNull(configured.maximum) ?? 60,
    multiplier: numberOrNull(configured.multiplier) ?? 2,
    jitter: numberOrNull(configured.jitter) ?? 0
  };
};

export const reconnectDelay = (policy, attempt, random = Math.random) => {
  const base = Math.min(policy.maximum, policy.initial * (policy.multiplier ** attempt));
  const jitter = Math.max(0, Number(policy.jitter) || 0);
  if (!jitter) return base;
  const factor = 1 + ((random() * 2) - 1) * jitter;
  return Math.max(0, base * factor);
};

export function parseJsonResponse(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const parts = raw.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    if (!parts.length) return null;
    const parsed = [];
    for (const part of parts) {
      try {
        parsed.push(JSON.parse(part));
      } catch {
        throw new Error(`Failed to parse JSON. Received text: ${text}`);
      }
    }
    return parsed.length === 1 ? parsed[0] : parsed;
  }
}

export async function fetchApi(s, n, opts = {}) {
  const { vars = {}, configPath, debug, ...rest } = opts;
  const req = getRequest(s, n, { ...vars, ...rest }, configPath, opts);
  if (debug) {
    console.error('\x1b[90m> %s %s\x1b[0m\n\x1b[90m> headers:\n%s\x1b[0m', req.method, req.url, 
      Object.entries(req.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n'));
    if (req.body) console.error('\x1b[90m> body: %s\x1b[0m', req.body.slice(0, 200) + (req.body.length > 200 ? '...' : ''));
  }
  const body = req.multipart ? getMultipartBody(req.multipart) : req.file ? getFileBody(req.file) : req.body || undefined;
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body });
  if (debug) {
    console.error('\n\x1b[90m< %s %s\x1b[0m', res.status, res.statusText);
    for (const [k, v] of res.headers.entries()) console.error('\x1b[90m< %s: %s\x1b[0m', k, v);
  }
  return res;
}

export async function fetchWS(s, n, opts = {}) {
  const { vars = {}, configPath, debug, onMessage, onStatus, ...rest } = opts;
  const { base, steps } = getFlow(s, n, configPath, opts);
  const flow = steps.length ? steps : (base ? [base] : []);
  if (!flow.length) throw new Error(`Unknown API: ${s}.${n}`);
  const baseDefaults = steps.length ? base : null;
  const captures = {};
  let sent = new Set();
  let ws;
  let current = 0;
  let requestTimer;
  let heartbeatTimer;
  let livenessTimer;
  let reconnectTimer;
  let currentReq;
  let connectionSeq = 0;
  let settled = false;
  let userClosing = false;
  let reconnectAttempt = 0;
  let stableTimer;
  const disconnectedSockets = new WeakSet();

  const merge = (step) => {
    if (!baseDefaults) return step;
    return { ...baseDefaults, ...step, headers: step.headers ?? baseDefaults.headers, capture: step.capture ?? baseDefaults.capture };
  };
  const mergedFlow = flow.map(merge);
  const longLived = isLongLivedWs(mergedFlow);
  const reconnect = reconnectConfig(mergedFlow);
  const currentApi = () => merge(flow[current]);
  const canAdvance = () => {
    if (!currentReq?.keep_alive) return false;
    if (current >= flow.length - 1) return false;
    const nextRaw = flow[current + 1];
    if (nextRaw?.url != null) return false;
    const capKeys = Object.keys(currentReq.capture || {});
    return capKeys.length === 0 || capKeys.every(k => captures[k] != null);
  };

  await new Promise((resolve, reject) => {
    const emitStatus = (event) => {
      if (onStatus) onStatus({ service: s, name: n, ...event });
    };
    const closeReason = (event, cause) => {
      if (cause?.message) return cause.message;
      if (event?.reason) return event.code ? `${event.code} ${event.reason}` : event.reason;
      if (event?.code) return `code ${event.code}`;
      return userClosing ? 'client closed' : 'closed';
    };
    const emitConnected = (socket, url) => {
      emitStatus({ type: 'connected', url, connected: true, reconnectAttempt });
    };
    const emitDisconnected = (socket, reason) => {
      if (!socket || disconnectedSockets.has(socket)) return;
      disconnectedSockets.add(socket);
      emitStatus({ type: 'disconnected', reason, connected: false, reconnectAttempt });
    };
    const clear = (name) => {
      if (name === 'request' && requestTimer) clearTimeout(requestTimer), requestTimer = null;
      if (name === 'heartbeat' && heartbeatTimer) clearTimeout(heartbeatTimer), heartbeatTimer = null;
      if (name === 'liveness' && livenessTimer) clearTimeout(livenessTimer), livenessTimer = null;
      if (name === 'reconnect' && reconnectTimer) clearTimeout(reconnectTimer), reconnectTimer = null;
      if (name === 'stable' && stableTimer) clearTimeout(stableTimer), stableTimer = null;
    };
    const stopLiveness = () => {
      clear('heartbeat');
      clear('liveness');
    };
    const stopReconnect = () => clear('reconnect');
    const stopAllTimers = () => {
      clear('request');
      stopLiveness();
      stopReconnect();
      clear('stable');
    };
    const finish = (err) => {
      if (settled) return;
      settled = true;
      stopAllTimers();
      if (ws && ws.readyState === WebSocket.OPEN && err) {
        emitDisconnected(ws, err.message);
        userClosing = true;
        try { ws.close(); } catch {}
      }
      if (err) reject(err);
      else resolve();
    };
    const setRequestTimer = (t, seq) => {
      clear('request');
      if (t == null) return;
      requestTimer = setTimeout(() => {
        if (seq !== connectionSeq || settled) return;
        finish(new Error('WebSocket connection timeout'));
      }, t * 1000);
    };
    const parseIncoming = (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString();
      let msg;
      try { msg = JSON.parse(raw); } catch {}
      return { raw, msg };
    };
    const send = (value) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(wsPayload(value));
      return true;
    };
    const startLivenessTimeout = () => {
      if (!isKeepAliveConfig(currentReq?.keep_alive)) return;
      const timeout = numberOrNull(resolveWsValue(currentReq.keep_alive.timeout, { ...vars, ...captures }));
      if (timeout == null) return;
      clear('liveness');
      livenessTimer = setTimeout(() => {
        if (settled) return;
        scheduleReconnect(new Error('WebSocket liveness timeout'), connectionSeq);
      }, timeout * 1000);
    };
    const markAlive = () => {
      if (!isKeepAliveConfig(currentReq?.keep_alive)) return;
      clear('liveness');
      const keepAlive = currentReq.keep_alive;
      if (keepAlive.send == null && keepAlive.interval == null && keepAlive.timeout != null) startLivenessTimeout();
    };
    const sendHeartbeat = () => {
      if (!isKeepAliveConfig(currentReq?.keep_alive) || settled) return;
      const keepAlive = currentReq.keep_alive;
      if (keepAlive.send != null) send(resolveWsValue(keepAlive.send, { ...vars, ...captures }));
      startLivenessTimeout();
      scheduleHeartbeat();
    };
    const scheduleHeartbeat = () => {
      if (!isKeepAliveConfig(currentReq?.keep_alive) || settled) return;
      clear('heartbeat');
      const interval = numberOrNull(resolveWsValue(currentReq.keep_alive.interval, { ...vars, ...captures }));
      if (interval == null) return;
      heartbeatTimer = setTimeout(sendHeartbeat, interval * 1000);
    };
    const startLiveness = () => {
      stopLiveness();
      if (!isKeepAliveConfig(currentReq?.keep_alive)) return;
      if (currentReq.keep_alive.interval == null && currentReq.keep_alive.send == null) markAlive();
      scheduleHeartbeat();
    };
    const createWebSocket = (req, seq) => {
      const options = req.headers && Object.keys(req.headers).length ? { headers: req.headers } : undefined;
      const socket = new WebSocket(req.url, options);
      socket.addEventListener('message', (ev) => {
        if (seq !== connectionSeq || settled) return;
        onMsg(ev);
      });
      socket.addEventListener('close', (event) => {
        if (seq !== connectionSeq || settled) return;
        onClose(event, socket);
      });
      socket.addEventListener('error', (e) => {
        if (seq !== connectionSeq || settled) return;
        onErr(e, socket, seq);
      });
      return socket;
    };
    const openConnection = () => {
      stopAllTimers();
      sent = new Set();
      current = 0;
      currentReq = null;
      connectionSeq += 1;
      userClosing = false;
      sendStep(0, false, connectionSeq);
    };
    const scheduleReconnect = (cause, seq = connectionSeq) => {
      stopLiveness();
      clear('request');
      emitDisconnected(ws, closeReason(null, cause));
      if (!reconnect || userClosing) return finish(cause);
      if (reconnectTimer) return;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.close(); } catch {}
      }
      stopReconnect();
      const delay = reconnectDelay(reconnect, reconnectAttempt++);
      reconnectTimer = setTimeout(() => {
        if (settled) return;
        openConnection();
      }, delay * 1000);
    };
    const resetReconnectAfterStableConnection = () => {
      clear('stable');
      stableTimer = setTimeout(() => {
        reconnectAttempt = 0;
      }, 1000);
    };
    const onErr = (e, socket, seq) => {
      const error = e instanceof Error ? e : new Error(String(e));
      emitDisconnected(socket, error.message);
      scheduleReconnect(error, seq);
    };
    const onClose = (event, socket) => {
      emitDisconnected(socket, closeReason(event));
      if (current < flow.length - 1) {
        const nextRaw = flow[current + 1];
        if (nextRaw?.url != null) return sendStep(current + 1, false);
      }
      if (longLived && !userClosing && reconnect) return scheduleReconnect(new Error('WebSocket closed'));
      finish();
    };
    const onMsg = (ev) => {
      const { raw, msg } = parseIncoming(ev);
      const cap = currentReq?.capture || {};
      if (msg && Object.keys(cap).length) {
        for (const [k, q] of Object.entries(cap)) {
          const value = runJq(q, JSON.stringify(msg)).trim();
          if (value !== '') captures[k] = value;
        }
      }
      if (isKeepAliveConfig(currentReq?.keep_alive)) {
        const expect = currentReq.keep_alive.expect;
        if (expect == null || matchesExpectation(msg ?? raw, expect)) markAlive();
        if (currentReq.keep_alive.interval != null && !heartbeatTimer) scheduleHeartbeat();
      }
      if (onMessage) onMessage(msg ?? raw, {
        service: s,
        name: n,
        step: current,
        raw,
        send,
        close: () => {
          userClosing = true;
          if (ws) ws.close();
        },
        vars: { ...vars },
        captures: { ...captures },
        connected: ws?.readyState === WebSocket.OPEN,
        reconnecting: Boolean(reconnectTimer),
        reconnectAttempt
      });
      if (canAdvance()) sendStep(current + 1, true);
    };
    function sendStep(idx, reuse, seq = connectionSeq) {
      if (settled || seq !== connectionSeq) return;
      current = idx;
      if (sent.has(idx)) return;
      sent.add(idx);
      const v = { ...vars, ...captures };
      currentReq = buildWsRequest(currentApi(), v);
      if (!reuse) {
        stopLiveness();
        ws = createWebSocket(currentReq, seq);
      }
      const doSend = () => {
        if (seq !== connectionSeq || settled) return;
        clear('request');
        resetReconnectAfterStableConnection();
        if (!reuse) emitConnected(ws, currentReq.url);
        if (debug) console.error('\x1b[90m> WS %s\x1b[0m', currentReq.url ?? '(reuse)');
        if (currentReq.body) send(currentReq.body);
        startLiveness();
        if (canAdvance()) sendStep(current + 1, true);
      };
      if (ws.readyState === WebSocket.OPEN) doSend();
      else ws.addEventListener('open', doSend, { once: true });
      setRequestTimer(currentReq.timeout, seq);
    }
    try { openConnection(); } catch (e) { finish(e); }
  });
}

export async function get(id, opts = {}) {
  const [s, n] = id.split('.'), res = await fetchApi(s, n, opts);
  const text = await res.text();
  const parsed = parseJsonResponse(text);
  return {
    json: (q) => q ? runJq(q, typeof parsed === 'string' ? parsed : JSON.stringify(parsed)) : parsed,
    text: () => text
  };
}

export async function* parseSseStream(readableStream) {
  const reader = readableStream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1 || (boundary = buffer.indexOf('\r\n\r\n')) !== -1) {
        const isCr = buffer[boundary] === '\r';
        const sepLen = isCr ? 4 : 2;
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + sepLen);
        const event = parseSseBlock(block);
        if (event) yield event;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const event = parseSseBlock(buffer);
      if (event) yield event;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseBlock(block) {
  let event = 'message';
  let dataLines = [];
  let id = null;
  const lines = block.split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(line[5] === ' ' ? 6 : 5));
    } else if (line.startsWith('event:')) {
      event = line.slice(line[6] === ' ' ? 7 : 6);
    } else if (line.startsWith('id:')) {
      id = line.slice(line[3] === ' ' ? 4 : 3);
    }
  }
  if (!dataLines.length && !id && event === 'message') return null;
  const data = dataLines.join('\n');
  return { event, data, id, raw: block };
}

export async function* parseNdjsonStream(readableStream) {
  const reader = readableStream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line.trim()) {
          yield { event: 'message', data: line, raw: line };
        }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const line = buffer.replace(/\r$/, '');
      if (line.trim()) yield { event: 'message', data: line, raw: line };
    }
  } finally {
    reader.releaseLock();
  }
}

export function formatStreamChunk(data, jq) {
  if (data == null || data === '' || data === '[DONE]') return null;
  let parsed;
  try {
    parsed = typeof data === 'object' ? data : JSON.parse(data);
  } catch {
    return data;
  }
  if (!parsed || typeof parsed !== 'object') return String(parsed);

  if (jq) {
    const trimmed = String(jq).trim();
    if (trimmed === '.choices[0].message.content' || trimmed === 'choices[0].message.content') {
      const deltaContent = parsed?.choices?.[0]?.delta?.content;
      if (deltaContent !== undefined) return deltaContent;
      const messageContent = parsed?.choices?.[0]?.message?.content;
      if (messageContent !== undefined) return messageContent;
      return null;
    }
    if (trimmed === '.choices[0].delta.content' || trimmed === 'choices[0].delta.content') {
      return parsed?.choices?.[0]?.delta?.content ?? null;
    }
    if (
      trimmed === '.choices[0].delta.content // .choices[0].delta.reasoning' ||
      trimmed === '.choices[0].delta.content // .choices[0].delta.reasoning // empty' ||
      trimmed === '.choices[0].delta.content // .choices[0].delta.reasoning // .choices[0].message.content' ||
      trimmed === '.choices[0].delta | .content // .reasoning' ||
      trimmed === '.choices[0].delta | .content // .reasoning // empty'
    ) {
      const delta = parsed?.choices?.[0]?.delta;
      if (delta?.content !== undefined) return delta.content;
      if (delta?.reasoning !== undefined) return delta.reasoning;
      if (delta?.reasoning_content !== undefined) return delta.reasoning_content;
      const messageContent = parsed?.choices?.[0]?.message?.content;
      if (messageContent !== undefined) return messageContent;
      return null;
    }
    if (trimmed === '.choices[0].delta.reasoning' || trimmed === 'choices[0].delta.reasoning') {
      return parsed?.choices?.[0]?.delta?.reasoning ?? parsed?.choices?.[0]?.delta?.reasoning_content ?? null;
    }
    if (trimmed === '.message.content' || trimmed === 'message.content') {
      return parsed?.message?.content ?? null;
    }
    try {
      const out = runJq(jq, JSON.stringify(parsed));
      return out ? out.trimEnd() : null;
    } catch {
      return null;
    }
  }

  const delta = parsed?.choices?.[0]?.delta;
  if (delta?.content !== undefined) {
    return delta.content;
  }
  if (delta?.reasoning !== undefined) {
    return delta.reasoning;
  }
  if (delta?.reasoning_content !== undefined) {
    return delta.reasoning_content;
  }
  if (parsed?.delta?.text !== undefined) {
    return parsed.delta.text;
  }
  if (parsed?.message?.content !== undefined) {
    return parsed.message.content;
  }
  if (delta && (delta.role !== undefined || Object.keys(delta).length === 0)) {
    return null;
  }
  if (Array.isArray(parsed?.choices) && parsed.choices.length === 0) {
    return null;
  }

  return JSON.stringify(parsed);
}

