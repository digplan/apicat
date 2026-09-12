import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { formatResponse, runCli } from '../src/cli.js';
import { fetchApi, getApis, getRequest, parseSseStream, parseNdjsonStream, formatStreamChunk } from '../src/fetch.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = join(root, 'apicat.yaml');
const uploadConfig = join(root, 'tests/fixtures/upload.yaml');
const uploadFile = join(root, 'tests/fixtures/upload-body.txt');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test('cli usage includes all options with --stream marked as default if not specified', async () => {
  const output = [];
  const code = await runCli([], { out: value => output.push(value) });

  assert.strictEqual(code, 0);
  const text = output.join('\n');
  assert.match(text, new RegExp(`apicat\\x1b\\[0m \\x1b\\[90mv${version} — call APIs`));
  assert.match(text, /--time/);
  assert.match(text, /--debug/);
  assert.match(text, /--response/);
  assert.match(text, /--stream.*default if not specified/);
  assert.match(text, /--no-stream/);
  assert.match(text, /--config/);
  assert.match(text, /-h, --help/);
});

test('cli --help and apic help display usage with all options', async () => {
  const helpOutput = [];
  const code1 = await runCli(['--help'], { out: value => helpOutput.push(value) });
  assert.strictEqual(code1, 0);
  const helpText = helpOutput.join('\n');
  assert.match(helpText, /--stream.*default if not specified/);
  assert.match(helpText, /--no-stream/);
  assert.match(helpText, /-h, --help/);

  const bareHelpOutput = [];
  const code2 = await runCli(['help'], { out: value => bareHelpOutput.push(value) });
  assert.strictEqual(code2, 0);
  const bareHelpText = bareHelpOutput.join('\n');
  assert.match(bareHelpText, /--stream.*default if not specified/);
  assert.match(bareHelpText, /--no-stream/);
  assert.match(bareHelpText, /-h, --help/);
});

test('apic help <service.name> prints API help text', async () => {
  const output = [];
  const code = await runCli(['-config', config, 'help', 'httpbin.get'], {
    out: value => output.push(value)
  });

  assert.strictEqual(code, 0);
  assert.deepStrictEqual(output, ['Send a GET request to httpbin.org/get.']);
});

test('api help prints the YAML help text without making a request', async () => {
  const output = [];
  const code = await runCli(['-config', config, 'httpbin.get', '--help'], {
    out: value => output.push(value)
  });

  assert.strictEqual(code, 0);
  assert.deepStrictEqual(output, ['Send a GET request to httpbin.org/get.']);
});

test('update refuses to overwrite an existing config without confirmation', async () => {
  const errors = [];
  const code = await runCli(['update'], {
    err: value => errors.push(value),
    userConfigPath: config
  });

  assert.strictEqual(code, 1);
  assert.deepStrictEqual(errors, [`Refusing to overwrite ${config} without confirmation. Run \`apic update\` in an interactive terminal.`]);
});

test('jq API field prints raw selected output', () => {
  const catfact = getApis(config).find(api => api.id === 'catfact.getFact');

  assert.strictEqual(catfact.jq, '.fact');
  assert.strictEqual(formatResponse('{"fact":"Cats purr."}', catfact.jq), 'Cats purr.');
});

test('JSON request bodies escape multiline variable values', () => {
  const prompt = 'First line\nA "quoted" path: C:\\temp';
  const req = getRequest('ollama', 'chat', {
    OLLAMA_MODEL: 'phi4:latest',
    PROMPT: prompt
  }, config);

  const body = JSON.parse(req.body);
  assert.strictEqual(body.model, 'phi4:latest');
  assert.strictEqual(body.messages[1].content, prompt);
});

test('file uploads read the configured local file as bytes', async (t) => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, ...init };
    return new Response('ok');
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const req = getRequest('test', 'raw', { FILE: uploadFile }, uploadConfig);
  assert.strictEqual(req.file, uploadFile);
  await fetchApi('test', 'raw', { vars: { FILE: uploadFile }, configPath: uploadConfig });

  assert.strictEqual(request.url, 'https://upload.example/raw');
  assert.ok(Buffer.isBuffer(request.body));
  assert.strictEqual(request.body.toString(), 'binary-safe upload body\n');
});

test('multipart uploads support file and text fields', async (t) => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, ...init };
    return new Response('ok');
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await fetchApi('test', 'multipart', {
    vars: { FILE: uploadFile, DESCRIPTION: 'An upload' },
    configPath: uploadConfig
  });

  assert.strictEqual(request.url, 'https://upload.example/multipart');
  assert.ok(request.body instanceof FormData);
  assert.strictEqual(await request.body.get('document').text(), 'binary-safe upload body\n');
  assert.strictEqual(request.body.get('document').name, 'upload-body.txt');
  assert.strictEqual(request.body.get('description'), 'An upload');
});

test('download output writes response bytes to FILE_PATH', async (t) => {
  const originalFetch = globalThis.fetch;
  const tempDir = mkdtempSync(join(tmpdir(), 'apicat-download-'));
  const filePath = join(tempDir, 'download.bin');
  globalThis.fetch = async () => new Response(new Uint8Array([0, 1, 2, 255]));
  t.after(() => {
    globalThis.fetch = originalFetch;
    rmSync(tempDir, { recursive: true, force: true });
  });

  const output = [];
  const code = await runCli(['--config', uploadConfig, 'test.download', `FILE_PATH=${filePath}`], {
    out: value => output.push(value)
  });

  assert.strictEqual(code, 0);
  assert.deepStrictEqual([...readFileSync(filePath)], [0, 1, 2, 255]);
  assert.deepStrictEqual(output, [filePath]);
});

test('cli.js module and apicli executable list APIs', async () => {
  const moduleOut = [];
  const moduleErr = [];
  const code = await runCli(['-config', config, 'ls'], {
    out: (...args) => moduleOut.push(args.join(' ')),
    err: (...args) => moduleErr.push(args.join(' '))
  });

  assert.strictEqual(code, 0);
  assert.deepStrictEqual(moduleErr, []);
  assert.strictEqual(moduleOut[0], '');
  assert.match(moduleOut.join('\n'), /\x1b\[36mhttpbin\.get\x1b\[0m/);
  assert.strictEqual(moduleOut.at(-1), '');

  const executable = spawnSync(process.execPath, [join(root, 'src/apicli'), '-config', config, 'ls'], {
    encoding: 'utf8',
    cwd: root
  });

  assert.strictEqual(executable.status, 0);
  assert.strictEqual(executable.stderr, '');
  assert.match(executable.stdout, /^\n\x1b\[36mbasert\.chat\x1b\[0m/m);
  assert.match(executable.stdout, /\n\n$/);
});

test('list output is alphabetically ordered by API ID', async () => {
  const output = [];
  const code = await runCli(['--config', config, 'ls'], { out: value => output.push(value) });
  const ids = output
    .filter(value => value.startsWith('\x1b[36m'))
    .map(value => value.replace(/^\x1b\[36m|\x1b\[0m$/g, ''));

  assert.strictEqual(code, 0);
  assert.deepStrictEqual(ids, [...ids].sort((a, b) => a.localeCompare(b)));
});

test('.apicat in current directory overrides ~/.apicat', async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), 'apicat-override-'));
  const userConfig = join(tempDir, 'user.apicat');
  const localConfig = join(tempDir, '.apicat');

  writeFileSync(userConfig, 'userapi.get:\n  url: https://user.example/api\n  method: GET\n');
  writeFileSync(localConfig, 'localapi.get:\n  url: https://local.example/api\n  method: GET\n  help: Local API help text\n');

  t.after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const apis = getApis(null, { cwd: tempDir, userConfigPath: userConfig });
  assert.strictEqual(apis.some(a => a.id === 'localapi.get'), true);
  assert.strictEqual(apis.some(a => a.id === 'userapi.get'), false);

  const req = getRequest('localapi', 'get', {}, null, { cwd: tempDir, userConfigPath: userConfig });
  assert.strictEqual(req.url, 'https://local.example/api');
  assert.throws(() => getRequest('userapi', 'get', {}, null, { cwd: tempDir, userConfigPath: userConfig }), /Unknown API/);

  const output = [];
  const code = await runCli(['ls'], {
    cwd: tempDir,
    userConfigPath: userConfig,
    out: value => output.push(value)
  });

  assert.strictEqual(code, 0);
  assert.match(output.join('\n'), /localapi\.get/);
  assert.doesNotMatch(output.join('\n'), /userapi\.get/);

  const helpOut = [];
  const helpCode = await runCli(['localapi.get', '--help'], {
    cwd: tempDir,
    userConfigPath: userConfig,
    out: value => helpOut.push(value)
  });
  assert.strictEqual(helpCode, 0);
  assert.deepStrictEqual(helpOut, ['Local API help text']);
});

test('apicat.yaml in current directory adds definitions to ~/.apicat', async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), 'apicat-yaml-'));
  const userConfig = join(tempDir, 'user.apicat');
  const localYaml = join(tempDir, 'apicat.yaml');

  writeFileSync(userConfig, 'baseapi.get:\n  url: https://base.example/api\n  method: GET\nshared.api:\n  url: https://base.example/shared\n  method: GET\n');
  writeFileSync(localYaml, 'extraapi.get:\n  url: https://extra.example/api\n  method: GET\n  help: Extra API help text\nshared.api:\n  url: https://overridden.example/shared\n  method: POST\n');

  t.after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const apis = getApis(null, { cwd: tempDir, userConfigPath: userConfig });
  const ids = apis.map(a => a.id).sort();
  assert.deepStrictEqual(ids, ['baseapi.get', 'extraapi.get', 'shared.api']);

  const sharedApi = apis.find(a => a.id === 'shared.api');
  assert.strictEqual(sharedApi.url, 'https://overridden.example/shared');
  assert.strictEqual(sharedApi.method, 'POST');

  const baseReq = getRequest('baseapi', 'get', {}, null, { cwd: tempDir, userConfigPath: userConfig });
  assert.strictEqual(baseReq.url, 'https://base.example/api');
  const extraReq = getRequest('extraapi', 'get', {}, null, { cwd: tempDir, userConfigPath: userConfig });
  assert.strictEqual(extraReq.url, 'https://extra.example/api');
  const sharedReq = getRequest('shared', 'api', {}, null, { cwd: tempDir, userConfigPath: userConfig });
  assert.strictEqual(sharedReq.url, 'https://overridden.example/shared');
  assert.strictEqual(sharedReq.method, 'POST');

  const output = [];
  const code = await runCli(['ls'], {
    cwd: tempDir,
    userConfigPath: userConfig,
    out: value => output.push(value)
  });

  assert.strictEqual(code, 0);
  assert.match(output.join('\n'), /baseapi\.get/);
  assert.match(output.join('\n'), /extraapi\.get/);
  assert.match(output.join('\n'), /shared\.api/);

  const helpOut = [];
  const helpCode = await runCli(['extraapi.get', '--help'], {
    cwd: tempDir,
    userConfigPath: userConfig,
    out: value => helpOut.push(value)
  });
  assert.strictEqual(helpCode, 0);
  assert.deepStrictEqual(helpOut, ['Extra API help text']);
});

test('both .apicat and apicat.yaml in current directory: .apicat overrides ~/.apicat and apicat.yaml is added', async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), 'apicat-both-'));
  const userConfig = join(tempDir, 'user.apicat');
  const localConfig = join(tempDir, '.apicat');
  const localYaml = join(tempDir, 'apicat.yaml');

  writeFileSync(userConfig, 'userapi.get:\n  url: https://user.example/api\n');
  writeFileSync(localConfig, 'localbase.get:\n  url: https://localbase.example/api\n');
  writeFileSync(localYaml, 'localextra.get:\n  url: https://localextra.example/api\n');

  t.after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const apis = getApis(null, { cwd: tempDir, userConfigPath: userConfig });
  const ids = apis.map(a => a.id).sort();
  assert.deepStrictEqual(ids, ['localbase.get', 'localextra.get']);
  assert.strictEqual(apis.some(a => a.id === 'userapi.get'), false);

  const executable = spawnSync(process.execPath, [join(root, 'src/apicli'), 'ls'], {
    encoding: 'utf8',
    cwd: tempDir
  });

  assert.strictEqual(executable.status, 0);
  assert.match(executable.stdout, /localbase\.get/);
  assert.match(executable.stdout, /localextra\.get/);
});

test('explicit --config ignores .apicat and apicat.yaml in current directory', async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), 'apicat-explicit-'));
  const customConfig = join(tempDir, 'custom.yaml');
  const localConfig = join(tempDir, '.apicat');
  const localYaml = join(tempDir, 'apicat.yaml');

  writeFileSync(customConfig, 'custom.api:\n  url: https://custom.example/api\n');
  writeFileSync(localConfig, 'localbase.get:\n  url: https://localbase.example/api\n');
  writeFileSync(localYaml, 'localextra.get:\n  url: https://localextra.example/api\n');

  t.after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const apis = getApis(customConfig, { cwd: tempDir });
  assert.deepStrictEqual(apis.map(a => a.id), ['custom.api']);

  const output = [];
  const code = await runCli(['--config', customConfig, 'ls'], {
    cwd: tempDir,
    out: value => output.push(value)
  });

  assert.strictEqual(code, 0);
  assert.match(output.join('\n'), /custom\.api/);
  assert.doesNotMatch(output.join('\n'), /localbase\.get/);
  assert.doesNotMatch(output.join('\n'), /localextra\.get/);
});

test('parseSseStream handles events, comments, and multiple data lines', async () => {
  const sseContent = ': comment\n\ndata: first\n\ndata: second part 1\ndata: second part 2\nevent: custom\nid: 42\n\ndata: [DONE]\n\n';
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sseContent));
      controller.close();
    }
  });

  const events = [];
  for await (const ev of parseSseStream(stream)) {
    events.push(ev);
  }

  assert.strictEqual(events.length, 3);
  assert.strictEqual(events[0].data, 'first');
  assert.strictEqual(events[0].event, 'message');
  assert.strictEqual(events[1].data, 'second part 1\nsecond part 2');
  assert.strictEqual(events[1].event, 'custom');
  assert.strictEqual(events[1].id, '42');
  assert.strictEqual(events[2].data, '[DONE]');
});

test('formatStreamChunk extracts delta tokens from OpenAI and Ollama chunks', () => {
  assert.strictEqual(formatStreamChunk('{"choices":[{"delta":{"content":"Hello"}}]}', '.choices[0].message.content'), 'Hello');
  assert.strictEqual(formatStreamChunk('{"choices":[{"delta":{"content":" world"}}]}', '.choices[0].delta.content'), ' world');
  assert.strictEqual(formatStreamChunk('{"message":{"content":"Hi"}}', '.message.content'), 'Hi');
  assert.strictEqual(formatStreamChunk('{"delta":{"text":"Anthropic"}}', null), 'Anthropic');
  assert.strictEqual(formatStreamChunk('{"choices":[{"delta":{"reasoning":"Thinking step"}}]}', null), 'Thinking step');
  assert.strictEqual(formatStreamChunk('{"choices":[{"delta":{"reasoning_content":"Thinking step 2"}}]}', null), 'Thinking step 2');
  assert.strictEqual(formatStreamChunk('{"choices":[{"delta":{"reasoning":"Thinking step"}}]}', '.choices[0].delta.content // .choices[0].delta.reasoning // empty'), 'Thinking step');
  assert.strictEqual(formatStreamChunk('{"choices":[{"delta":{"content":"Answer"}}]}', '.choices[0].delta.content // .choices[0].delta.reasoning // empty'), 'Answer');
  assert.strictEqual(formatStreamChunk('{"choices":[{"delta":{}}]}', null), null);
  assert.strictEqual(formatStreamChunk('[DONE]', '.choices[0].message.content'), null);
  assert.strictEqual(formatStreamChunk('{"choices":[{"delta":{"role":"assistant"}}]}', '.choices[0].message.content'), null);
  assert.strictEqual(formatStreamChunk('plain text', null), 'plain text');
});

test('cli streams SSE chat responses live without newlines between deltas', async (t) => {
  const originalFetch = globalThis.fetch;
  const chunks = [
    'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"!"}}]}\n\n',
    'data: [DONE]\n\n'
  ];

  globalThis.fetch = async () => {
    const stream = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        controller.close();
      }
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    });
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const written = [];
  const code = await runCli(['-config', config, 'celeris.chat', 'PROMPT=hi'], {
    write: chunk => written.push(chunk)
  });

  assert.strictEqual(code, 0);
  assert.strictEqual(written.join(''), 'Hello world!\n');
});

test('cli streams raw SSE events when --response flag is specified', async (t) => {
  const originalFetch = globalThis.fetch;
  const chunk = 'data: {"choices":[{"delta":{"content":"Test"}}]}\n\n';

  globalThis.fetch = async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      }
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    });
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const written = [];
  const code = await runCli(['-config', config, 'celeris.chat', 'PROMPT=hi', '--response'], {
    write: chunk => written.push(chunk)
  });

  assert.strictEqual(code, 0);
  assert.match(written.join(''), /data: \{"choices":\[\{"delta":\{"content":"Test"\}\}\]\}/);
});

test('--stream flag sets stream in body and headers and --no-stream disables it', () => {
  const reqStream = getRequest('ollama', 'chat', { OLLAMA_MODEL: 'm', PROMPT: 'p' }, config, { stream: true });
  assert.strictEqual(JSON.parse(reqStream.body).stream, true);
  assert.match(reqStream.headers.Accept, /text\/event-stream/);

  const reqNoStream = getRequest('ollama', 'chat', { OLLAMA_MODEL: 'm', PROMPT: 'p' }, config, { noStream: true });
  assert.strictEqual(JSON.parse(reqNoStream.body).stream, false);
});

test('cli streams NDJSON responses', async (t) => {
  const originalFetch = globalThis.fetch;
  const ndjson = '{"message":{"content":"Line1"}}\n{"message":{"content":"Line2"}}\n';

  globalThis.fetch = async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(ndjson));
        controller.close();
      }
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' }
    });
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const written = [];
  const code = await runCli(['-config', config, 'ollama.chat', 'OLLAMA_MODEL=m', 'PROMPT=hi', '--stream'], {
    write: chunk => written.push(chunk)
  });

  assert.strictEqual(code, 0);
  assert.strictEqual(written.join(''), 'Line1Line2\n');
});

test('HTTP error responses on streaming endpoints fallback to error formatting', async (t) => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    return new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' }
    });
  };

  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const output = [];
  const code = await runCli(['-config', config, 'celeris.chat', 'PROMPT=hi', '--stream', '--response'], {
    out: value => output.push(value)
  });

  assert.strictEqual(code, 0);
  assert.match(output.join('\n'), /Invalid API key/);
});


