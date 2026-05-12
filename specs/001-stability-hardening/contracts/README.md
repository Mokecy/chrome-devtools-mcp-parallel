# Tool Contracts — Stability Hardening

**Feature**: `001-stability-hardening` |
**Spec**: [../spec.md](../spec.md) |
**Data model**: [../data-model.md](../data-model.md) |
**Migration guide**: [../migration.md](../migration.md)

This directory holds the I/O schema + error-code reference for every
new MCP tool registered by the stability hardening feature. One file
per tool; all are **additive** — no existing tool's schema changed.

| Tool                         | Contract                                               | Purpose                                                                  |
| ---------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------ |
| `instance_health`            | [instance-health.md](./instance-health.md)             | Lifecycle snapshot for every registered instance                         |
| `instance_recreate`          | [instance-recreate.md](./instance-recreate.md)         | Re-launch a dead instance, preserving id + downloadPath                  |
| `page_artifact_read_summary` | [artifact-read-summary.md](./artifact-read-summary.md) | Read previously persisted heap/trace/response, return structured summary |
| `system_observe`             | [system-observe.md](./system-observe.md)               | Per-instance + process memory + artifact disk usage snapshot             |

For the StructuredError envelope shared across these tools see
[`../data-model.md` §6](../data-model.md).
