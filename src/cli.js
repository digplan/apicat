import fs from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import { fetchApi, fetchWS, getApi, getApis, getFlow, getRequest, isReadableFile, parseJsonResponse, runJq, parseSseStream, parseNdjsonStream, formatStreamChunk } from './fetch.js';
import { ensureUserConfig, defaultUserConfigPath, defaultBundledConfigPath } from './install.js';
import { startProxy, checkBackend } from './proxy.js';
import { parseYaml } from './yaml.js';

const publishedConfigUrl = 'https://raw.githubusercontent.com/beachdevs/apicat/refs/heads/master/apicat.yaml';
const c = { dim: '\x1b[90m', cyan: '\x1b[36m', green: '\x1b[32m', bold: '\x1b[1m', reset: '\x1b[0m' };
const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const usage = `
🔌 ${c.bold}apicat${c.reset} ${c.dim}v${version} — call APIs (${c.cyan}apic${c.reset})${c.reset}

${c.bold}Commands${c.reset}
  ${c.green}apic <service.name>${c.reset} [k=v …]  Call API with optional params
  ${c.cyan}apic ls|list${c.reset} [pattern]       List APIs
  ${c.cyan}apic update${c.reset}                  Copy latest published ${c.dim}.apicat${c.reset} to ${c.dim}~/.apicat${c.reset}
  ${c.cyan}apic help${c.reset} [service|pattern]  Show help or search config for pattern
  ${c.cyan}apic <service.name> --help${c.reset}   Show help for this api call
  ${c.cyan}apic proxy -p <port>${c.reset} [${c.dim}-P <backend host:port>${c.reset}] [${c.dim}-B|--bearer <env key name>${c.reset}]
                       Forward HTTP requests; -P pins the backend target, -B adds a Bearer auth header from an env var

${c.bold}Options${c.reset}
  ${c.cyan}apic <service.name> --time${c.reset}           Show request duration
  ${c.cyan}apic <service.name> --debug${c.reset}          Show fetch request/response info
  ${c.cyan}apic <service.name> --response${c.reset}       Output raw response (skip jq filter)
  ${c.cyan}apic <service.name> --stream${c.reset}         Stream response events / tokens (default if not specified)
  ${c.cyan}apic <service.name> --no-stream${c.reset}      Disable streaming (wait for full response)
  ${c.cyan}apic --config <path> httpbin.get${c.reset}     Use custom config file instead of ${c.dim}~/.apicat${c.reset}
  ${c.cyan}apic -h, --help${c.reset}                      Show help
`;

export const formatResponse = (text, jq) => jq ? runJq(jq, text).trimEnd() : JSON.stringify(parseJsonResponse(text), null, 2);

const apiParams = (api) => {
  const vars = new Map();
  const scan = (v) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(/(\$\$)|(\$!?)([A-Za-z_]\w*)/g)) {
        if (m[1]) continue;
        const name = m[3], req = m[2].includes('!');
        vars.set(name, (vars.get(name) ?? false) || req);
      }
    } else if (Array.isArray(v)) for (const x of v) scan(x);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) scan(x);
  };
  for (const f of ['url', 'headers', 'body', 'file', 'multipart', 'output']) {
    if (f === 'body' && api.body != null) scan(String(api.body));
    else scan(api[f]);
  }
  return [...vars.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, req]) => `${name}${req ? '!' : ''}`);
};

export const parseArgs = (raw = []) => {
  const flags = ['-time', '--time', '-debug', '--debug', '-h', '--help', '-p', '-P', '-B', '--bearer', '-response', '--response', '-stream', '--stream', '-no-stream', '--no-stream'];
  const configIdx = raw.findIndex(a => a === '-config' || a === '--config');
  const portIdx = raw.indexOf('-p');
  const backendIdx = raw.indexOf('-P');
  const bearerIdx = raw.findIndex(a => a === '-B' || a === '--bearer');
  if (configIdx >= 0 && (!raw[configIdx + 1] || raw[configIdx + 1].startsWith('-'))) return { error: 'Error: -config requires a file path' };
  if (portIdx >= 0 && (!raw[portIdx + 1] || raw[portIdx + 1].startsWith('-'))) return { error: 'Error: -p requires a port' };
  if (backendIdx >= 0 && (!raw[backendIdx + 1] || raw[backendIdx + 1].startsWith('-'))) return { error: 'Error: -P requires a backend host:port' };
  if (bearerIdx >= 0 && (!raw[bearerIdx + 1] || raw[bearerIdx + 1].startsWith('-'))) return { error: 'Error: --bearer requires an env key name' };
  const skip = new Set();
  for (const i of [configIdx, portIdx, backendIdx, bearerIdx]) if (i >= 0) skip.add(i).add(i + 1);
  const args = raw.filter((a, i) => !flags.includes(a) && !skip.has(i));
  return { args, arg: args[0], pattern: args[1] ?? '.', time: raw.includes('-time') || raw.includes('--time'), debug: raw.includes('-debug') || raw.includes('--debug'), response: raw.includes('-response') || raw.includes('--response'), stream: raw.includes('-stream') || raw.includes('--stream'), noStream: raw.includes('-no-stream') || raw.includes('--no-stream'), help: raw.includes('-h') || raw.includes('--help'), configPath: configIdx >= 0 ? raw[configIdx + 1] : null, port: portIdx >= 0 ? raw[portIdx + 1] : null, proxyBackend: backendIdx >= 0 ? raw[backendIdx + 1] : null, proxyBearer: bearerIdx >= 0 ? raw[bearerIdx + 1] : null };
};

export async function runCli(raw = process.argv.slice(2), io = {}) {
  const out = io.out ?? console.log, err = io.err ?? console.error;
  const write = io.write ?? (io.out ? io.out : (s) => process.stdout.write(s));
  const cwd = io.cwd ?? process.cwd();
  const localConfigPath = io.localConfigPath ?? join(cwd, '.apicat');
  const userConfigPath = io.userConfigPath ?? defaultUserConfigPath;
  const localYamlConfigPath = io.localYamlConfigPath ?? join(cwd, 'apicat.yaml');
  const bundledConfigPath = io.bundledConfigPath ?? defaultBundledConfigPath;

  const hasLocal = () => isReadableFile(localConfigPath);
  const hasUser = () => isReadableFile(userConfigPath);
  const hasBundled = () => isReadableFile(bundledConfigPath);
  const hasLocalYaml = () => isReadableFile(localYamlConfigPath);

  const resolveBase = () => (hasLocal() ? localConfigPath : hasUser() ? userConfigPath : hasBundled() ? bundledConfigPath : null);

  const { error, args, arg, pattern, time, debug, response, stream, noStream, help, configPath, port, proxyBackend, proxyBearer } = parseArgs(raw);
  const re = (s) => new RegExp(s.replace(/\*/g, '.*'), 'i');

  const printConfig = () => {
    if (configPath) {
      err('config:', configPath);
      return;
    }
    const base = resolveBase();
    if (base) {
      err(hasLocal() ? 'local:  ' : hasUser() ? 'user:   ' : 'bundled:', base);
    }
    if (hasLocalYaml() && localYamlConfigPath !== base) {
      err('added:  ', localYamlConfigPath);
    }
  };

  const search = (rx) => {
    const filesToSearch = [];
    if (configPath) {
      if (isReadableFile(configPath)) filesToSearch.push(configPath);
    } else {
      const base = resolveBase();
      if (base) filesToSearch.push(base);
      if (hasLocalYaml() && localYamlConfigPath !== base) filesToSearch.push(localYamlConfigPath);
    }
    for (const p of filesToSearch) {
      for (const l of fs.readFileSync(p, 'utf8').split('\n')) {
        if (rx.test(l)) out(l);
      }
    }
  };

  const update = async () => {
    const targetPath = (hasLocal() && !io.userConfigPath) ? localConfigPath : userConfigPath;
    if (fs.existsSync(targetPath)) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error(`Refusing to overwrite ${targetPath} without confirmation. Run \`apic update\` in an interactive terminal.`);
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = (await rl.question(`This will overwrite ${targetPath}. Are you sure? [y/N] `)).trim().toLowerCase();
        if (answer !== 'y' && answer !== 'yes') {
          out('Update cancelled.');
          return false;
        }
      } finally {
        rl.close();
      }
    }
    const r = await fetch(publishedConfigUrl);
    if (!r.ok) throw new Error(`Failed to download ${publishedConfigUrl}: ${r.status} ${r.statusText}`);
    const text = await r.text();
    parseYaml(text);
    fs.writeFileSync(targetPath, text, 'utf8');
    out(targetPath);
    return true;
  };

  if (error) return err(error), 1;
  if (arg === 'proxy') {
    if (help) return out(usage), 0;
    try {
      if (proxyBackend && !(await checkBackend(proxyBackend))) {
        err(`Error: cannot reach proxy backend ${proxyBackend}`);
        return 1;
      }
      startProxy({ port: Number(port) || 8080, backend: proxyBackend, bearer: proxyBearer, out });
      return 0;
    } catch (e) {
      err(e.message);
      return 1;
    }
  }
  await ensureUserConfig({ arg, configPath, localConfigPath, userConfigPath, bundledConfigPath });
  if (!args.length || (arg === 'help' && !args[1])) printConfig();
  if (!arg || (help && !/^\w+\.\w+$/.test(arg)) || (arg === 'help' && !args[1])) return out(usage), 0;
  if (arg === 'ls' || arg === 'list') {
    out('');
    for (const a of getApis(configPath, io).sort((a, b) => (a.id ?? `${a.service}.${a.name}`).localeCompare(b.id ?? `${b.service}.${b.name}`))) {
      const id = a.id ?? `${a.service}.${a.name}`;
      if (re(pattern).test(id)) {
        const params = apiParams(a);
        out(params.length ? `${c.cyan}${id}${c.reset} [${params.join(', ')}]` : `${c.cyan}${id}${c.reset}`);
      }
    }
    out('');
    return 0;
  }
  if (arg === 'help') {
    if (/^\w+\.\w+$/.test(pattern)) {
      const [s, n] = pattern.split('.');
      const { base, steps } = getFlow(s, n, configPath, io), a = base ?? getApi(s, n, configPath, io);
      if (base || a || steps.length) {
        return out(base?.help ?? a?.help ?? steps[0]?.help ?? 'No help available.'), 0;
      }
    }
    return search(re(pattern)), 0;
  }
  if (arg === 'update') {
    try { await update(); return 0; } catch (e) { err(e.message); return 1; }
  }
  if (!/^\w+\.\w+$/.test(arg)) return search(re(arg)), 0;

  const [service, name] = arg.split('.'), params = Object.fromEntries(args.slice(1).map(a => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]).filter(([k]) => k));
  const { base, steps } = getFlow(service, name, configPath, io), api = base ?? getApi(service, name, configPath, io);
  if (!api && !steps.length) return err('Unknown API:', arg), 1;
  if (help) return out(base?.help ?? api?.help ?? steps[0]?.help ?? 'No help available.'), 0;
  const isWs = steps.length || String(api?.url ?? '').startsWith('ws');
  const hasBody = api?.body != null && String(api.body).trim() !== '';
  const hasUpload = api?.file != null || api?.multipart != null;
  const jsonPost = api?.method === 'POST' && (typeof api.headers === 'string' ? /json|^bearer /i.test(api.headers) : Object.entries(api?.headers || {}).some(([k, v]) => k.toLowerCase() === 'content-type' && String(v).toLowerCase().includes('json')));
  const opts = isWs || hasBody || hasUpload ? { vars: params, configPath, ...io } : jsonPost ? { body: JSON.stringify(params), configPath, ...io } : { vars: params, configPath, ...io };
  if (debug) opts.debug = true;
  if (stream) opts.stream = true;
  if (noStream) opts.noStream = true;
  try {
    const t0 = time ? process.hrtime.bigint() : null;
    let elapsed;
    if (isWs) {
      await fetchWS(service, name, {
        ...opts,
        onMessage: (_msg, ctx) => {
          if (debug) err(`\n\x1b[90m< WS message:\n%s\x1b[0m`, ctx.raw);
          out(response ? ctx.raw : (api?.jq ? runJq(api.jq, ctx.raw).trimEnd() : ctx.raw));
        },
        onStatus: (event) => {
          if (event.type === 'connected') err(`# Connected to: ${event.url}`);
          if (event.type === 'disconnected') err(`# Disconnected (${event.reason})`);
        }
      });
      if (t0) elapsed = (Number(process.hrtime.bigint() - t0) / 1e6).toFixed(0);
    } else {
      const res = await fetchApi(service, name, opts);
      if (t0) elapsed = (Number(process.hrtime.bigint() - t0) / 1e6).toFixed(0);
      const { output } = getRequest(service, name, params, configPath, io);
      if (output && res.ok) {
        fs.writeFileSync(output, Buffer.from(await res.arrayBuffer()));
        out(output);
      } else {
        const contentType = res.headers.get('content-type') || '';
        const isSse = contentType.includes('text/event-stream');
        const isNdjson = contentType.includes('application/x-ndjson') || contentType.includes('application/jsonl');
        const isStreaming = res.ok && res.body && !noStream && (isSse || isNdjson || stream || api?.stream);

        if (isStreaming && (isSse || isNdjson || !contentType.includes('application/json'))) {
          const streamParser = isNdjson ? parseNdjsonStream(res.body) : parseSseStream(res.body);
          let lastChunkWritten = false;
          let endsWithNewline = false;
          for await (const ev of streamParser) {
            if (ev.data === '[DONE]') break;
            if (debug) err(`\n\x1b[90m< stream event (${ev.event}):\n%s\x1b[0m`, ev.raw);
            if (response) {
              write(ev.raw + '\n\n');
              lastChunkWritten = true;
              endsWithNewline = true;
            } else {
              const formatted = formatStreamChunk(ev.data, api?.stream_jq ?? api?.jq);
              if (formatted != null && formatted !== '') {
                write(formatted);
                lastChunkWritten = true;
                endsWithNewline = String(formatted).endsWith('\n');
              }
            }
          }
          if (lastChunkWritten && !endsWithNewline) write('\n');
        } else {
          const text = await res.text();
          if (debug) err(`\n\x1b[90m< response body:\n%s\x1b[0m`, text);
          out(response ? text : formatResponse(text, api?.jq));
        }
      }
    }
    if (elapsed) err(`\x1b[90m%ims\x1b[0m`, elapsed);
    return 0;
  } catch (e) {
    err(e.message);
    return 1;
  }
}
