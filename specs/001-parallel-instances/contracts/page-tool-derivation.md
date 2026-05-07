# Page Tool Derivation Contract

**Feature**: `001-parallel-instances` | **Phase**: 1 Design

本文件定义 upstream `chrome-devtools-mcp` 的启用工具 → `page_*` 并行派生工具的转换规则与等价性契约。

## 1. 派生规则

给定 upstream `ToolDefinition`：

```text
{
    name: <string>,                     // e.g. "navigate_page", "take_snapshot"
    description: <string>,
    schema: { <inputSchema> },
    annotations: { category, conditions, ... },
    handler: <fn>,
    pageScoped?: boolean,
    blockedByDialog?: boolean
}
```

派生为 `DerivedTool`：

| 派生字段                           | 规则                                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                             | `page_${upstream.name}`                                                                                                                                                   |
| `description`                      | `"[Parallel] " + upstream.description + " (operates on specified instance)"`                                                                                              |
| `inputSchema.type`                 | `"object"`（固定）                                                                                                                                                        |
| `inputSchema.properties`           | `{ instanceId: {type:'string', minLength:1, description:'Target instance id'}, ...upstream.schema.properties }` — **`instanceId` 位于对象键序列首位**，便于客户端 UI 排版 |
| `inputSchema.required`             | `['instanceId', ...(upstream.schema.required ?? [])]` — 去重，保持顺序                                                                                                    |
| `inputSchema.additionalProperties` | `false`（若 upstream 未声明则沿用 upstream；显式 `false` 防止未知字段意外透传）                                                                                           |
| `annotations`                      | 原样透传（category / conditions / readOnlyHint 等）                                                                                                                       |
| `dispatch`                         | 见 §2                                                                                                                                                                     |

## 2. `dispatch` 执行序列

```text
async function dispatch(instanceId: string, upstreamParams: UpstreamParams): Promise<CallToolResult> {
    // 1. 查表
    const instance = registry.get(instanceId);
    if (!instance) return isError("Instance <id> not found.");

    // 2. 可用性检查
    if (!instance.available) return isError("Instance <id> is currently unavailable (connection lost, retrying)...");

    // 3. 加锁（同 id 串行，不同 id 并行）
    using release = await instanceMutex.acquire(instanceId);

    // 4. 准备 response 与 page
    const response = createMcpResponse(serverArgs);
    const page = instance.mcpContext.getSelectedMcpPage();  // 由 page_select_page 等工具改动
    response.setPage(page);
    if (upstreamTool.blockedByDialog) page.throwIfDialogOpen();

    // 5. 委托 upstream handler
    try {
        if (upstreamTool.pageScoped) {
            await upstreamTool.handler({ params: upstreamParams, page }, response, instance.mcpContext);
        } else {
            await upstreamTool.handler({ params: upstreamParams }, response, instance.mcpContext);
        }
    } catch (err) {
        response.setError(err);
    }

    // 6. 生成结果
    const { content, structuredContent } = await response.handle(upstreamTool.name, instance.mcpContext);
    const result = { content, isError: response.hasError };
    if (serverArgs.experimentalStructuredContent) result.structuredContent = structuredContent;

    // 7. 快照增强（仅 take_snapshot）
    if (upstreamTool.name === 'take_snapshot' && !result.isError) {
        const enhanced = await snapshotEnhancer.process({
            text: extractPrimaryText(result.content),
            prev: instance.prevSnapshot,
            prevOrigin: instance.prevSnapshotOrigin,
            page,
        });
        replacePrimaryText(result.content, enhanced.text);
        instance.prevSnapshot = enhanced.canonicalText;
        instance.prevSnapshotOrigin = enhanced.origin;
    }

    // 8. telemetry (upstreamTool.name 不是 derived name，保持与非并行模式统计对齐)
    telemetry.logToolInvocation({ toolName: `page_${upstreamTool.name}`, success: !result.isError, ... });

    return result;
}
```

### 不变式

- `dispatch` 中**不**修改 upstream 工具的参数语义；只做 `instanceId` 脱壳（`upstreamParams` 已剔除 `instanceId`）。
- 所有 upstream handler 的类型签名通过泛型传递，不使用 `as` 类型断言。
- 步骤 7 的增强对**有错误**的结果不执行（保留原始错误信息）。

## 3. 等价性契约（用于 SC-003）

对每个派生工具定义等价性断言：

> 给定相同输入（不含 `instanceId`）与**纯净**实例（刚创建、无历史副作用），`page_<name>` 的返回 content 与独立 chrome-devtools-mcp 单实例模式下 `<name>` 的返回 content **语义等价**。

容许差异：

1. `page_take_snapshot`：首次调用等价于 upstream `take_snapshot`（降噪可能令行数减少，但 a11y 树结构信息无损）；且额外追加 `[CDP Field States]` 与 `[pageState: ...]` 块。第 2+ 次调用可能返回 diff-only，此时以两次返回的累加视为等价。
2. `page_*` 中涉及 `selectedPage` 的工具：selected page 由实例独立维护，不与 upstream 全局 selectedPage 共享。
3. 错误文案中的实例 id 前缀与 upstream 原文不同，不视为行为不等价。

**任何非上列允许差异的行为偏差视为 bug**，纳入回归测试覆盖（≥20 代表性工具）。

## 4. 禁用工具的派生策略

遵循 FR-008：

- upstream 启用逻辑 `getToolStatusInfo(tool, serverArgs).disabled === true` 且 `serverArgs.viaCli === false` 时，upstream 不注册；派生层同样**不注册**对应 `page_*`。
- 启用逻辑受 `--categoryXxx`、`--slim`、`--experimentalPageIdRouting` 等 CLI flag 影响；并行 bin 透传这些 flag 到 upstream 的 `getToolStatusInfo`，保持一致。

## 5. 示例

### 5.1 `page_navigate_page`（upstream `navigate_page`）

```json
{
  "name": "page_navigate_page",
  "description": "[Parallel] Navigates the currently selected page to a URL (operates on specified instance)",
  "inputSchema": {
    "type": "object",
    "properties": {
      "instanceId": {
        "type": "string",
        "minLength": 1,
        "description": "Target instance id"
      },
      "url": {"type": "string", "description": "URL to navigate to"}
    },
    "required": ["instanceId", "url"],
    "additionalProperties": false
  }
}
```

### 5.2 `page_take_snapshot`（upstream `take_snapshot`）

```json
{
  "name": "page_take_snapshot",
  "description": "[Parallel] Take a text snapshot of the currently selected page. The snapshot contains an accessibility tree (operates on specified instance)",
  "inputSchema": {
    "type": "object",
    "properties": {
      "instanceId": {
        "type": "string",
        "minLength": 1,
        "description": "Target instance id"
      }
    },
    "required": ["instanceId"],
    "additionalProperties": false
  }
}
```

返回 content 模板（首次调用）：

```
<denoised accessibility tree>

[CDP Field States]
- input[name=q] value="" placeholder="Search" disabled=false
- textarea#comment value="hello world" disabled=false

[pageState: normal]
```

返回 content 模板（二次调用、变化 ≤35%）：

```
[snapshot diff, 12 lines changed out of 420 (2.9%)]
- <div>Old Text</div>
+ <div>New Text</div>
...

[CDP Field States]
...

[pageState: normal]
```
