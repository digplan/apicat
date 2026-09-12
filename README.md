<p align="center">
  <img src="./logo.png" alt="apicat logo" width="220" />
</p>

`apicat` is a tiny API caller.

Keep your API definitions in YAML, then list them, inspect them, and fire them off from the CLI or from JavaScript. It is built for quick experiments, repeatable calls, and "what was that curl again?" moments.

## ⚡ Quick Start

```bash
npx apicat <service.name> KEY=VALUE
```

Or install it locally. Use ```apic``` instead of ```npx apicat```.

```bash
npm install -g apicat

$ apic ls
$ apic httpbin.get
```

```
🔌 apicat v0.3.25 — call APIs (apic)

Commands
  apic <service.name> [k=v …]  Call API with optional params
  apic ls|list [pattern]       List APIs (e.g. apic list "openrouter")
  apic update                  Copy latest published .apicat to ~/.apicat
  apic help [service|pattern]  Show help or search config for pattern
  apic <service.name> --help   Show help for this api call
  apic proxy -p <port> [-P <backend host:port>] [-B|--bearer <env key name>]
                       Forward HTTP requests; -P pins the backend target, -B adds a Bearer auth header from an env var

Options
  apic <service.name> --time           Show request duration
  apic <service.name> --debug          Show fetch request/response info + full response body
  apic <service.name> --response       Output raw response (skip jq filter)
  apic <service.name> --stream         Stream response events / tokens (default if not specified)
  apic <service.name> --no-stream      Disable streaming (wait for full response)
  apic --config <path> httpbin.get     Use custom config file instead of ~/.apicat
  apic -h, --help                      Show help
```

## 🤖 Model Context Protocol (MCP) Server for AI Agents

`apicat` includes an ultra-fast, native Rust MCP server (`mcp/`) that lets AI coding assistants (Antigravity, Cursor, Claude Desktop, Claude Code, Windsurf, Cline) call and execute API definitions with **zero token-reading overhead**, **sub-5ms cold starts**, and **in-memory TLS connection pooling**.

### 1. Compile the MCP Binary
```bash
cargo build --release --manifest-path mcp/Cargo.toml
```
The compiled binary will be at `mcp/target/release/apicat-mcp`.

### 2. Configure Your AI Agent
Add `apicat` to your agent's MCP configuration (`mcp_config.json`, `.cursor/mcp.json`, or `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "apicat": {
      "command": "/absolute/path/to/apicat/mcp/target/release/apicat-mcp"
    }
  }
}
```

---

## ⚡ Empirical Performance & Benchmark Matrix

### 1. Real-World Autonomous Agent Task Performance
Measured on an AI billing and quota audit task across Fireworks AI and OpenRouter:

| Strategy | Total Wall Time | LLM Turns | Context Token Footprint | Discovery Overhead |
| :--- | :---: | :---: | :---: | :--- |
| **Unassisted Agent (CLI & Search)** | 21.0s | **10 turns** | ~18,400 tokens | 5 exploratory tool calls |
| **Skill-Assisted CLI (`apic`)** | ~4.5s | 1–2 turns | ~1,200 tokens | 0 tool calls |
| **In-Memory Rust MCP Server** | **~2.5s** | **1 turn** | **~650 tokens** | **0 calls (6.0x faster, 96.5% token savings)** |

### 2. Three-Way Batch API Execution
Batch execution across four live API calls (`catfact.getFact`, `fireworks.balance`, `openrouter.key`, `fireworks.costs`):

| Endpoint | Raw `curl` (Subprocess) | `apic` CLI (Node.js) | **In-Memory Rust MCP** | Improvement |
| :--- | :---: | :---: | :---: | :---: |
| **`catfact.getFact`** | 157.8 ms | 390.5 ms | **117.6 ms** | 🚀 **1.34x faster** *(+40 ms)* |
| **`openrouter.key`** | 188.3 ms | 358.4 ms | **131.1 ms** | 🚀 **1.44x faster** *(+57 ms)* |
| **`fireworks.costs`** | 1,198.7 ms | 1,242.4 ms | **783.1 ms** | 🚀 **1.53x faster** *(+416 ms)* |
| **`fireworks.balance`** | 2,748.1 ms | 1,394.6 ms | **1,742.0 ms** | 🚀 **1.58x faster** *(+1,006 ms)* |
| **Total Batch (4 Calls)** | **4,292.9 ms** | **3,385.8 ms** | **2,773.8 ms** | ⚡ **1.55x faster (+1.52s saved)** |

### 3. MCP Runtime Architecture Comparison
Comparing MCP server implementations across languages:

| Metric | **Rust (Native Release)** | **Bun (TypeScript)** | **Python 3.14 (Stdlib)** |
| :--- | :---: | :---: | :---: |
| **Cold Start & Handshake** *(Spawn → Init → tools/list)* | **4.36 ms** | 37.24 ms | 42.79 ms |
| **Raw JSON-RPC IPC Latency** *(Stdio Ping)* | **0.018 ms (18 µs)** | 0.058 ms (58 µs) | 0.028 ms (28 µs) |
| **Memory Footprint (RSS)** | **1.77 MB** | 22.83 MB | 17.45 MB |
| **Host Runtime Dependencies** | **None (Standalone binary)** | Requires Bun/Node | Requires Python |

### 4. The Impact of In-Memory Connection Pooling (Keep-Alive)
Reusing warm TCP and TLS 1.3 encryption sockets eliminates DNS and handshake latency:

* **Cold Socket (`openrouter.key`)**: 4,066 ms
* **Warm Reused Socket (`openrouter.key`)**: **468 ms (8.7x speedup)**

---

## 🤖 Prompting LLMs directly
If you want an AI to learn your raw API definitions without MCP:

`Learn api definitions from https://unpkg.com/apicat`

## 🎉 API goodness

- One command: `apic`
- One bundled config file: `~/.apicat`
- HTTP and WebSocket support
- Declarative WebSocket keep-alive, liveness checks, and reconnect
- Simple forward proxy: `apic proxy -p <port> [-P <backend host:port>]`
- Variables with `$VAR` and required variables with `$!VAR`
- Works as a CLI, a library, and an exported CLI module

## 🧠 How It Thinks

On first interactive run, it can copy the bundled `apicat.yaml` to `~/.apicat`. Edit to your liking.

When an `.apicat` file exists in the current directory, it automatically overrides `~/.apicat`. If an `apicat.yaml` file exists in the current directory, those definitions get added to what is in `~/.apicat` (or `./.apicat`) for the client to use.

Variables can be defined in the call or will be used if named the same in env.

API IDs use `<service>.<name>` form, like `httpbin.get`, `openai.chat`, or `echo.ws`.

## 🧰 CLI Cheatsheet

```bash
# show the menu
apic

# list available apis
apic ls

# show help for an API
apic openai.chat --help

# use a different config
apic --config ./custom.yaml ls

# time or debug your calls
apic httpbin.get --time
apic httpbin.get --debug
# debug also prints the full raw response body to stderr,
# even when the API's jq filter would normally trim it

# output the raw response, skipping any jq filter
apic httpbin.get --response

# refresh ~/.apicat from the published apicat.yaml
apic update

# forward HTTP requests through a local proxy
# without -P it forwards to the host in each request
apic proxy -p 8080
# with -P it pins the backend: all requests go there
# a bare port (e.g. -P 3000) means localhost:3000
apic proxy -p 8080 -P api.example.com:443

# OpenAI-compatible chat
apic openai.chat \
  OPENAI_URL=https://api.openai.com \
  OPENAI_API_KEY=$OPENAI_API_KEY \
  MODEL=gpt-4o-mini \
  PROMPT="Write a haiku about logs"

# OpenRouter
apic openrouter.chat \
  API_KEY=$OPENROUTER_API_KEY \
  MODEL=openrouter/auto \
  PROMPT="Say hello"

# macOS: use clipboard text as a prompt
PROMPT="$(pbpaste)" apic <service.name>
```

## Key Value Parameters

```
apic openrouter.chat MODEL="openrouter/auto" PROMPT="Reply with only: ok"

Values will automatically be used if they exist in env. e.g. API_KEY

export API_KEY=...

# In the yaml config
openrouter.chat:
  url: https://openrouter.ai/api/v1/chat/completions
  method: POST
  headers:
    Authorization: "Bearer $!API_KEY"
  body: |
    {
      "model": "$!MODEL",
      "messages": [{"role": "user", "content": "$OPTIONAL_PROMPT"}, {"role": "user", "content": "$!PROMPT"}]
      , "provider": {"order": ["$PROVIDER"]}
    }
  jq: .choices[0].message.content
  help: Create an OpenRouter chat completion. Requires API_KEY, MODEL, and PROMPT.
```

## 💻 Use It From Code

Install it locally if you want to import it:

```bash
npm install -g apicat
```

Then:

```javascript
import { fetchApi, getApis, getRequest } from 'apicat';

const apis = getApis();
console.log(apis.map((api) => api.id));

const req = getRequest('httpbin', 'get');
console.log(req.url);

const res = await fetchApi('httpbin', 'get');
console.log(await res.json());

const chat = await fetchApi('openai', 'chat', {
  vars: {
    OPENAI_URL: 'https://api.openai.com',
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    MODEL: 'gpt-4o-mini',
    PROMPT: 'Hello world'
  }
});

console.log(await chat.json());
```

To load API definitions from a specific file, pass its path as `configPath`:

```javascript
const res = await fetchApi('httpbin', 'get', {
  configPath: './custom.yaml'
});
```

Without `configPath`, apicat checks for `.apicat` in the current directory (which overrides `~/.apicat`), falls back to `~/.apicat` when present (or the bundled `apicat.yaml`), and merges in any definitions from `apicat.yaml` found in the current directory.

For an OpenRouter chat completion, pass the values referenced by the `openrouter.chat` definition in `vars`:

```javascript
import { fetchApi } from 'apicat';

const res = await fetchApi('openrouter', 'chat', {
  vars: {
    API_KEY: process.env.OPENROUTER_API_KEY,
    MODEL: 'openrouter/auto',
    OPTIONAL_PROMPT: 'Be concise.',
    PROMPT: 'Give me one interesting cat fact.'
  }
});

if (!res.ok) throw new Error(`OpenRouter request failed: ${res.status} ${await res.text()}`);

const data = await res.json();
console.log(data.choices[0].message.content);
```

## YAML config
Simple! See apicat.yaml.

### WebSocket keep-alive and reconnect

WebSocket APIs can be finite request/response calls or long-lived listeners. Long-lived protocols can define heartbeat, liveness, and reconnect behavior declaratively in YAML:

```yaml
example.listener:
  url: wss://example.com/socket
  capture:
    sequence: .s
    heartbeat_interval: .d.heartbeat_interval / 1000
  keep_alive:
    interval: $heartbeat_interval
    send:
      op: 1
      d: $sequence
    expect:
      op: 11
    timeout: 10
  reconnect:
    enabled: true
    initial: 1
    maximum: 60
    multiplier: 2
    jitter: 0.2
```

`capture` values are available to later WebSocket flow steps and heartbeat messages. `expect` is matched as a partial object, so `op: 11` matches any incoming JSON message whose `op` field is `11`.

When called from the CLI, WebSocket connection status is written to stderr with comment-style prefixes:

```text
# Connected to: wss://example.com/socket
# Disconnected (closed)
```

### File uploads

Use `file` to send a local file as the raw request body. `FILE` is a convention; any substituted variable can provide the path.

```yaml
cloudflare.r2Upload:
  url: https://api.cloudflare.com/client/v4/accounts/$!CLOUDFLARE_ACCOUNT_ID/r2/buckets/$!CLOUDFLARE_BUCKET/objects/$!FILE_NAME
  method: PUT
  file: $!FILE
  headers:
    Authorization: Bearer $!CLOUDFLARE_API_KEY
    Content-Type: $CONTENT_TYPE
```

Use a scoped Cloudflare API token for `CLOUDFLARE_API_KEY`. `FILE` is the local path and `FILE_NAME` is the R2 object key.

Downloads write response bytes to `FILE_PATH`:

```yaml
cloudflare.r2Download:
  url: https://api.cloudflare.com/client/v4/accounts/$!CLOUDFLARE_ACCOUNT_ID/r2/buckets/$!CLOUDFLARE_BUCKET/objects/$!FILE_NAME
  method: GET
  headers:
    Authorization: Bearer $!CLOUDFLARE_API_KEY
  output: $!FILE_PATH
```

```bash
apic cloudflare.r2Download FILE_NAME=logo.png FILE_PATH=./downloaded-logo.png
```

For `multipart/form-data` APIs, use `multipart`. A field containing `file` becomes a file part; all other fields are sent as text.

```yaml
example.multipartUpload:
  url: https://example.com/upload
  method: POST
  multipart:
    document:
      file: $!FILE
      content_type: $CONTENT_TYPE
    description: $DESCRIPTION
```

You may set `filename` alongside `file` and `content_type`; otherwise apicat uses the local filename. Do not set a multipart `Content-Type` header manually—apicat supplies the required boundary.
