# Management Tools Contracts

**Feature**: `001-parallel-instances` | **Phase**: 1 Design

本文件给出并行模式下 6 个管理工具的完整 JSON Schema 契约。字段均为正式输入/输出规格，`/speckit.tasks` 生成的任务与实现 MUST 严格遵循。

通用约定：

- 所有工具返回 `CallToolResult`：`{ content: Array<{ type:'text', text:string }>, isError?: boolean }`。
- 错误返回 `isError: true` 并把错误文本放入 content[0]。
- 管理工具均通过 `InstanceMutex` 的**全局锁**串行执行（与 `page_*` 互斥）。
- 工具描述中 `[Parallel]` 前缀为**并行工具**专有标识；管理工具不带此前缀，直接使用简洁描述。

---

## 1. `browser_connect`

**Description**: `Connect to a Chrome/Edge instance with remote debugging enabled and extract its auth state as the global AuthState for subsequent instances.`

### inputSchema

```json
{
  "type": "object",
  "properties": {
    "cdpUrl": {
      "type": "string",
      "description": "Optional explicit CDP endpoint (http://host:port or ws://...). If omitted, probes 127.0.0.1:9222/9223/9224."
    },
    "pageIndex": {
      "type": "number",
      "minimum": 0,
      "description": "Optional index of the page to use when extracting auth storage (localStorage). Default 0 (first non-blank page)."
    },
    "autoLaunch": {
      "type": "boolean",
      "description": "When no debug port is found, whether to auto-launch a Chrome/Edge instance with an isolated profile. Defaults to CLI flag --auto-launch (default true)."
    }
  },
  "additionalProperties": false
}
```

### Success Output (text)

```
Connected to <browserType> at <cdpUrl>.
AuthState captured: <N> cookies, <M> origins with localStorage.
```

### Error Modes

| Condition                                                  | Text                                                                                                                   |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| No port found & autoLaunch=false                           | `No debug port detected. Start Chrome manually: chrome.exe --remote-debugging-port=9222 --user-data-dir=<path>`        |
| Auto-launch executed but never became reachable within 10s | `Auto-launched Chrome but failed to connect within 10s. Try a manual launch.`                                          |
| Explicit cdpUrl unreachable                                | `Failed to connect to <cdpUrl>: <reason>`                                                                              |
| Connection succeeded but no usable page                    | `Connected but no usable page to extract localStorage; cookies captured.` (NOT an error, just a warning line appended) |

---

## 2. `instance_create`

**Description**: `Create a new isolated browser instance. Supports cloning the current global AuthState to skip re-login.`

### inputSchema

```json
{
  "type": "object",
  "properties": {
    "instanceId": {
      "type": "string",
      "minLength": 1,
      "description": "Unique identifier for this instance. Must not already exist."
    },
    "url": {
      "type": "string",
      "description": "Optional initial URL to navigate to after the instance is ready."
    },
    "cloneAuth": {
      "type": "boolean",
      "default": true,
      "description": "When true and a global AuthState exists, inject its cookies & localStorage into the new context before the first navigation."
    },
    "useCDP": {
      "type": "boolean",
      "description": "When true (default if connected), create the instance as an isolated BrowserContext inside the connected browser (preserves httpOnly cookies and SSO). When false, launch an independent browser process. If true but no connected browser exists, silently falls back to launch mode."
    }
  },
  "required": ["instanceId"],
  "additionalProperties": false
}
```

### Success Output

```
Instance <id> created in <mode> mode.
[useCDP requested but no connected browser, fell back to launch]   # optional, Q3 fallback
Navigated to <url>.                                                # optional, only when url provided
Auth cloned: <N> cookies, <M> origins.                             # optional, only when cloneAuth && AuthState existed
```

### Error Modes

| Condition                       | Text                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| `instanceId` already exists     | `Instance <id> already exists; pick a different id or close the existing one.`                |
| `instanceId` empty / whitespace | `instanceId must be a non-empty string.`                                                      |
| Max instances reached           | `Instance limit (<N>) reached. Close an existing instance first or increase --max-instances.` |
| Underlying puppeteer failure    | `Failed to create instance <id>: <reason>`                                                    |

---

## 3. `instance_list`

**Description**: `List all live instances with their current main page URL and title.`

### inputSchema

```json
{"type": "object", "properties": {}, "additionalProperties": false}
```

### Success Output (text)

Multi-line table-like text, one line per instance:

```
Instances (<count>):
- <id>   [mode=cdp|launch]   url=<url>   title="<title>"   createdAt=<iso>   available=<bool>
- ...
```

Empty state: `No active instances.`

---

## 4. `instance_close`

**Description**: `Close a single instance and release its resources.`

### inputSchema

```json
{
  "type": "object",
  "properties": {
    "instanceId": {"type": "string", "minLength": 1}
  },
  "required": ["instanceId"],
  "additionalProperties": false
}
```

### Success Output

```
Instance <id> closed (<mode>).
```

### Error Modes

| Condition                       | Text                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| Not found                       | `Instance <id> not found.`                                                                  |
| Close operation partial failure | `Instance <id> removed from registry but puppeteer reported: <reason>` (NOT error; warning) |

---

## 5. `instance_close_all`

**Description**: `Close all instances at once.`

### inputSchema

```json
{"type": "object", "properties": {}, "additionalProperties": false}
```

### Success Output

```
Closed <N> instances.
```

Never errors; per-instance close failures become warnings appended after the summary line.

---

## 6. `instance_export_auth`

**Description**: `Export cookies and localStorage from the specified instance (or the connected CDP browser when omitted) and set them as the global AuthState for future instances.`

### inputSchema

```json
{
  "type": "object",
  "properties": {
    "instanceId": {
      "type": "string",
      "minLength": 1,
      "description": "Optional. When provided, export from this instance's context. Otherwise export from the connected CDP browser's default context."
    }
  },
  "additionalProperties": false
}
```

### Success Output

```
AuthState updated from <source>: <N> cookies, <M> origins with localStorage.
```

Where `<source>` = `instance <id>` or `connected browser`.

### Error Modes

| Condition                                             | Text                                                                         |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| Both missing (no instanceId AND no connected browser) | `No source to export from. Call browser_connect first or supply instanceId.` |
| instanceId not found                                  | `Instance <id> not found.`                                                   |
| Context already closed                                | `Instance <id> context is closed; cannot export.`                            |

---

## Non-Goals / Explicitly Out

- 这些工具**不**支持批量创建（`instance_create` 必须单次一个 id）；如需并发创建，客户端自行多次调用即可（global lock 串行保证 registry 一致性）。
- **不**提供 `instance_import_auth`：AuthState 来源仅限 `browser_connect` 与 `instance_export_auth`，避免外部不受信数据直接注入（减少攻击面）。
- **不**暴露 `AuthState` 内容给 AI（返回文本只给 cookie 数量与 origin 数量），防止 LLM 意外把凭证写进后续提示里。
