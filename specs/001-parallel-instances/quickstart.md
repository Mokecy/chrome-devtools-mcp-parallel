# Quickstart: Chrome DevTools MCP Parallel (5-minute path)

**Feature**: `001-parallel-instances` | **Phase**: 1 Design  
**Supports**: SC-006（新用户 ≤5 分钟跑通基础并行流程）

本文档面向**最终用户**（AI agent 开发者、QA 工程师），示意安装后如何在 5 分钟内跑通"连接已有 Chrome → 创建两个并行实例 → 并行完成两个任务"。

---

## 前置条件

- Node.js `^20.19.0 || ^22.12.0 || >=23`
- Chrome / Edge 近似最新稳定版
- MCP 客户端（Claude Desktop、Cursor、CodeMaker 等任一）

---

## 步骤 1 — 配置 MCP 客户端 (30 秒)

在 MCP 客户端配置文件中加入：

```json
{
  "mcpServers": {
    "chrome-parallel": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp-parallel@latest"]
    }
  }
}
```

重启客户端，等待工具列表加载完成。你会看到以下工具：

- 管理工具（6 个）：`browser_connect`、`instance_create`、`instance_list`、`instance_close`、`instance_close_all`、`instance_export_auth`
- 并行工具：每个 upstream chrome-devtools-mcp 工具的 `page_*` 版本（约 30+）

---

## 步骤 2 — 启动带调试端口的 Chrome 并登录 (60 秒)

在 Chrome 已关闭的前提下，任选一种方式启动：

**Windows** (PowerShell):

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
    --remote-debugging-port=9222 `
    --user-data-dir="$env:TEMP\chrome-parallel-profile"
```

**macOS**:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
    --remote-debugging-port=9222 \
    --user-data-dir=/tmp/chrome-parallel-profile
```

**Linux**:

```bash
google-chrome \
    --remote-debugging-port=9222 \
    --user-data-dir=/tmp/chrome-parallel-profile &
```

在弹出的 Chrome 窗口里**登录目标业务系统**（例如公司内网 SSO）。如果你懒得手动启动，跳过本步，下一步会自动拉起一个干净的调试 Chrome。

---

## 步骤 3 — 让 AI 连接 Chrome (10 秒)

发消息给 AI：

> 调用 `browser_connect` 连接本机 Chrome。

AI 会返回类似：

```
Connected to chrome at http://127.0.0.1:9222.
AuthState captured: 42 cookies, 3 origins with localStorage.
```

---

## 步骤 4 — 并行创建两个实例 (20 秒)

发消息给 AI：

> 调用 `instance_create` 创建实例 `task-1` 打开 `https://example.com/dashboard`；
> 再调用 `instance_create` 创建实例 `task-2` 打开 `https://example.com/reports`。

AI 会依次返回：

```
Instance task-1 created in cdp mode.
Navigated to https://example.com/dashboard.
Auth cloned: 42 cookies, 3 origins.

Instance task-2 created in cdp mode.
Navigated to https://example.com/reports.
Auth cloned: 42 cookies, 3 origins.
```

浏览器窗口右下角会出现 `🤖 task-1` 与 `🤖 task-2` 的可拖拽角标。

---

## 步骤 5 — 并行执行两个任务 (3 分钟)

现在发送任意业务描述，例如：

> 在 `task-1` 实例填写 dashboard 里的问卷；同时在 `task-2` 实例导出本月报表。

AI 会并行调用 `page_*` 工具（`page_fill`、`page_click`、`page_take_snapshot` 等）驱动两个实例。两个任务互不阻塞，cookie 互不干扰。

---

## 步骤 6 — 验证与清理 (10 秒)

- `instance_list` 查看当前实例：

  ```
  Instances (2):
  - task-1   [mode=cdp]   url=https://example.com/dashboard   title="Dashboard"   createdAt=...   available=true
  - task-2   [mode=cdp]   url=https://example.com/reports     title="Reports"     createdAt=...   available=true
  ```

- `instance_close_all` 一键回收：

  ```
  Closed 2 instances.
  ```

- 你手动启动的调试 Chrome 不会被 MCP 关闭；直接关窗即可。

---

## 常见问题

### Q1. 没手动启调试 Chrome 会怎样？

`browser_connect` 默认 `autoLaunch=true`，会自动用**独立 profile** 拉起一个调试 Chrome（不影响你日常浏览器）。如果想禁用自动拉起：

- 客户端侧：`browser_connect({ autoLaunch: false })`
- 服务端侧：启动命令追加 `--no-auto-launch`

### Q2. `useCDP=true` 和 `useCDP=false` 差别？

|                       | `useCDP=true`（默认） | `useCDP=false`            |
| --------------------- | --------------------- | ------------------------- |
| 浏览器进程            | 共享已连接的那一个    | 每实例独占一个新进程      |
| httpOnly Cookie / SSO | ✅ 保留               | ❌ 无法保留（需重新登录） |
| 隔离强度              | 上下文级              | 进程级（更强）            |
| 创建速度              | 快（毫秒级）          | 慢（启动浏览器约 1–2 秒） |

### Q3. 某个实例在跑到一半时 Chrome 崩溃了？

连接看门狗会周期探活，断连后最多 3 次自动重连（≤10 秒）。重连成功实例恢复；失败你会看到 `Instance <id> is currently unavailable`，此时可 `browser_connect` 重新连接然后重建实例。

### Q4. 如何把 `task-1` 完成登录后的状态作为后续新实例的默认鉴权？

在 `task-1` 里完成登录后：

```
instance_export_auth({ instanceId: "task-1" })
```

之后 `instance_create` 的新实例 `cloneAuth=true`（默认）即继承该鉴权。

---

## 完成

以上流程若耗时 ≤5 分钟，则达成 SC-006 标定的上手体验目标。
