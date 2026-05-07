# Phase 1 Data Model: Chrome DevTools MCP Parallel

**Feature**: `001-parallel-instances` | **Date**: 2026-05-07

本文件定义并行模式运行期的内存数据结构、关系与关键状态机。所有字段均在服务器进程内存中，无持久化。所有类型均用具体 TypeScript 类型表达，不使用 `any`/`as`/`!`。

## 1. `InstanceMode`

```text
type InstanceMode = 'cdp' | 'launch';
```

- `cdp`：实例运行在已连接的共享 Browser 进程内，独占一个 `BrowserContext`。
- `launch`：实例独占一个 `Browser` 进程（Puppeteer `launch` 启动）。

## 2. `Instance`（每实例内存对象）

| 字段                 | 类型                | 说明                                                                                                                                 |
| -------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                 | `string`            | 用户命名的 instanceId；非空；唯一约束由 `InstanceRegistry` 维护                                                                      |
| `mode`               | `InstanceMode`      | 创建时确定，不可变                                                                                                                   |
| `browser`            | `Browser` \| `null` | Puppeteer Browser 句柄；CDP 模式 = 共享 browser 的引用；launch 模式 = 该实例独占                                                     |
| `context`            | `BrowserContext`    | 该实例独占的 BrowserContext；CDP 模式下由 `browser.createBrowserContext()` 产生，launch 模式下等于 `browser.defaultBrowserContext()` |
| `contextId`          | `string`            | CDP 模式下用于看门狗重连后恢复 context 的标识（`context.id`）；launch 模式可为空字符串                                               |
| `selectedPageIdx`    | `number`            | 本实例的当前选中页索引；默认 0，由 `page_select_page`/`page_new_page` 变更                                                           |
| `downloadPath`       | `string`            | 绝对路径，实例独占                                                                                                                   |
| `badgeInjected`      | `WeakSet<Page>`     | 已注入角标脚本的 Page 集合，避免重复注入                                                                                             |
| `prevSnapshot`       | `string \| null`    | 上一帧 `page_take_snapshot` 的**降噪后**文本，供 diff 使用；实例首次调用为 null                                                      |
| `prevSnapshotOrigin` | `string \| null`    | 生成 prevSnapshot 时 selected page 的 origin；origin 切换时强制返回完整快照                                                          |
| `available`          | `boolean`           | 看门狗探活与生命周期维护；为 false 时 `page_*` 直接返回错误                                                                          |
| `mcpContext`         | `McpContext`        | upstream 的 `McpContext` 实例，复用其 page 管理、selected page、McpResponse 等                                                       |
| `createdAt`          | `Date`              | 创建时间，`instance_list` 展示用                                                                                                     |

### 不变式

1. `id` 在 `InstanceRegistry` 中唯一；重复创建抛错（FR-003）。
2. `cdp` 模式下，多个 Instance 的 `browser` 引用必须指向**同一个** ConnectedBrowser 的 `Browser` 实例。
3. `mcpContext.browser` 必须等价于本实例视图：通过 `BrowserLike` 适配器传入，仅暴露本 `context` 的 pages。
4. `available=false` 期间不接受任何 `page_*` 调用，但 `instance_close` / `instance_list` 仍允许。

### 生命周期状态机

```
(nonexistent)
    |
    | instance_create
    v
CREATING --(内部 ready)--> READY
                                |
                                | 看门狗检测到连接丢失 (仅 cdp)
                                v
                           UNAVAILABLE --(重连成功)--> READY
                                |
                                | (重连全部失败，或 instance_close)
                                v
                           CLOSING --(资源释放完)--> CLOSED
                                                        |
                                                        | (从 registry 移除)
                                                        v
                                                    (nonexistent)
```

- `CREATING` 阶段若异常（如 cdp 浏览器失联、auth 注入失败），回退到 `CLOSED` 并从 registry 移除，返回错误给调用者。
- `CLOSED` 状态不再对外暴露，立刻从 `InstanceRegistry` 中删除。

## 3. `AuthState`（全局单例）

```text
interface AuthCookie {
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;       // UNIX seconds, -1 表示 session
    httpOnly: boolean;
    secure: boolean;
    sameSite: 'Strict' | 'Lax' | 'None' | undefined;
}

interface AuthOriginStorage {
    origin: string;                        // 如 https://example.com
    items: ReadonlyArray<[string, string]>;  // localStorage 键值对
}

interface AuthState {
    cookies: ReadonlyArray<AuthCookie>;
    origins: ReadonlyArray<AuthOriginStorage>;
    capturedFrom: 'browser_connect' | 'instance_export_auth';
    capturedAt: Date;
}
```

- 读者：`AuthCloner.applyTo(context)` 在 `instance_create(cloneAuth=true)` 路径调用。
- 写者：`browser_connect`（从 connected browser）与 `instance_export_auth`（从指定实例或 connected browser）。每次整体替换，不做 merge（避免语义混乱）。
- 线程安全：Node.js 单线程 + 所有写入均在工具调用链内（通过 InstanceMutex 全局锁串行化），无需额外同步原语。

## 4. `ConnectedBrowser`（最多 1 个）

| 字段               | 类型                               | 说明                                                                                                 |
| ------------------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `browser`          | `Browser`                          | Puppeteer 连接后的 Browser                                                                           |
| `cdpUrl`           | `string`                           | 连接时的 WebSocket/HTTP endpoint，看门狗重连时复用                                                   |
| `browserType`      | `'chrome' \| 'edge' \| 'chromium'` | 用于日志与 `instance_list` 展示                                                                      |
| `autoLaunchedByUs` | `boolean`                          | true 时进程退出 hook 不关闭该浏览器（用户进程管理其生命周期）；false 表示用户自己启动，我们绝不 kill |
| `available`        | `boolean`                          | 看门狗维护，断连时置 false                                                                           |

### 关系

- `Instance.mode === 'cdp'` 的所有实例均引用同一 `ConnectedBrowser.browser`。
- `ConnectedBrowser` 关闭时：
  - `available=false`；
  - 所有 CDP 模式实例 `available=false` 并触发看门狗重连；
  - 重连成功 `available=true` 级联恢复所有实例。

## 5. `PageToolDerivation`

对每个 upstream 启用工具生成一个 `DerivedTool`：

```text
interface DerivedTool {
    name: string;                         // `page_${upstream.name}`
    description: string;                  // `[Parallel] ${upstream.description} (operates on specified instance)`
    inputSchema: JsonSchema;              // {properties: {instanceId: {type:'string'}, ...upstream.schema.properties}, required:['instanceId', ...upstream.required]}
    annotations: ToolAnnotations;         // 透传 upstream
    dispatch(instanceId: string, params: UpstreamParams): Promise<CallToolResult>;
}
```

不变式：

- `DerivedTool.name` 只在 upstream 工具经过 `getToolStatusInfo` 判定**启用**时生成（FR-008）。
- `DerivedTool.inputSchema.properties` 第一个键必然是 `instanceId`，保证客户端 UI 对齐（FR-006）。
- `DerivedTool.dispatch` 内部顺序：
  1. `registry.get(instanceId)` — 缺失直接返回 `{ isError:true, content:[text "Instance <id> not found"] }`；
  2. 若实例 `available=false` 返回 `{ isError:true, content:[text "Instance <id> is currently unavailable (connection lost, retrying)"] }`；
  3. `instanceMutex.acquire(instanceId)` —— 锁住本实例；
  4. 调用 upstream `tool.handler(...)`；
  5. 若 upstream name === `take_snapshot` → 运行 `SnapshotEnhancer.process(...)` 替换 content 并更新 `instance.prevSnapshot`；
  6. finally 释放锁，调用 telemetry 记录。

## 6. `InstanceMutex`

```text
class InstanceMutex {
    // 获取按 instanceId 的锁；同 id 串行，异 id 并行；id === undefined 视为整体锁（管理工具用），整体锁与任何 per-id 锁互斥。
    async acquire(instanceId?: string): Promise<Release>;
}
```

内部实现：

- `per-id: Map<string, MutexChain>` — 每 id 一条排队队列。
- `global: MutexChain` — 所有管理工具走这条。
- 约束：
  - 持有 per-id 锁 → 任何管理工具的 global 锁请求必须等所有 per-id 锁释放后才获得。
  - 持有 global 锁 → 任何 per-id 锁请求必须等 global 锁释放后才获得。
  - 用读写锁语义：global = "写"（独占），per-id = "读"（共享但同 id 串行）。

## 7. 关键关系图（简）

```
ConnectedBrowser --(1)---(N)-- Instance{mode=cdp}
                        \
                         (cdpUrl)
                          \
                           \-- ConnectionWatchdog

Instance --(1)---(1)-- BrowserContext
Instance --(1)---(1)-- McpContext（复用 upstream）
Instance --(1)---(1)-- downloadPath（独占目录）
Instance --(N)---(N)-- DerivedTool（通过 dispatch 关联）

AuthState <--(读/写)-- browser_connect / instance_export_auth / instance_create(cloneAuth)
```

## 8. 可变性与并发

- `InstanceRegistry` 的 `add/remove/get/refreshCdpBrowser` 均为同步操作，只在 `InstanceMutex` 的 global 锁内调用。
- `Instance.prevSnapshot` 读写均在 per-id 锁内（同一实例 `page_take_snapshot` 必然串行）。
- `AuthState` 为 frozen object，每次更新创建新实例后原子替换引用；读者拿到快照即稳定。
