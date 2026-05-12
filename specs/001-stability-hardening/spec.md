# Feature Specification: Chrome DevTools MCP Stability Hardening

**Feature Branch**: `001-stability-hardening`  
**Created**: 2026-05-11  
**Status**: Draft  
**Input**: User description: "Chrome DevTools MCP Stability Hardening: Circular Log Buffer, Product Persistence, CDP Self-healing, Heap Memory Backup"

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Long Session No Longer OOM Crashes (Priority: P1)

Testing engineers continuously run automated tasks on the same MCP instance for over an hour (covering a wide range of page jumps, form interactions, and network observation). In the current version, the process triggers V8 heap overflow with a console / network log overflow, the MCP connection is disconnected, and the ongoing test report is lost. After strengthening, the process memory usage remains controllable despite the session's duration, and long-running tasks can be completed stably.

**Why this priority**: This is the most commonly sensed "unstable" phenomenon and is also the core pain point where we differ from similar products (such as Playwright MCP). After fixing it, users can immediately increase their confidence in the product's stability and it becomes the foundation for other improvements.

**Independent Test**: Start an instance and loop execute 1000 times of the action "open page → trigger several network requests → write to console messages". Monitor process memory throughout the run. Acceptance criteria: within one hour total memory growth < 200 MB and the session remains continuous.

**Acceptance Scenarios**:

1. **Given** an instance already running for 1 hour with more than 10,000 collected messages, **when** calling the get console messages utility, **then** the system returns the latest N records and clearly informs "older records have been eliminated, a total of X records", and the process memory remains stable and does not increase
2. **Given** an instance already capturing more than 5,000 network requests, **when** querying by URL pattern, **then** the system retains up to the maximum number of requests while filtering and returning the result, without triggering memory alarms
3. **Given** users want to retain more history records, **when** starting with a parameter to increase the buffer limit, **then** the system works according to the new limit without exceeding the physical memory safety threshold

---

### User Story 2 - Large Objects No Longer Block MCP Channels (Priority: P1)

Users call tools that produce large volumes of data, such as screenshots, performance traces, memory snapshots, etc. In the current version, the entire base64 data is stuffed into the MCP response, causing single responses of several KB to tens of MB to block the standard input/output pipe, resulting in a 60-second timeout error; users neither receive the result nor know that the service has actually completed the task. After hardening, all large artifacts default to writing to disk, and the response only returns file paths and summary information, keeping the MCP channel lightweight.

**Why this priority**: This is the second largest root cause of reported "timeout" and "connection closed" issues. It is to be fixed together with P1 to fundamentally solve "using it looks good but it's unstable".

**Independent Test**: Take a screenshot of a full-screen long page, record a performance trace for three minutes, take a memory snapshot of a memory-intensive page, and verify that the response size is no more than 100 KB, the file is correctly written to disk, and the summary information is complete.

**Acceptance Scenarios**:

1. **Given** a page height exceeding 10,000 pixels, **When** calling the screenshot tool and not specifying a file path, **Then** the system automatically writes to the artifact directory, the response only contains the path and file size, and the call completes within a reasonable time without reporting a timeout
2. **Given** a user has started a performance recording, **When** the recording ends and the result is requested, **Then** the system returns the trace file path and key metric summary (such as event count, sampling window, core metrics), and does not embed the original trace in the response
3. **Given** a tool's response is about to exceed the predefined threshold, **When** the system is preparing to return the result, **Then** the system automatically writes the complete content to the file and returns `truncated=true` with the file path, and the caller can read it according to need
4. **Given** an artifact has been persisted to disk, **When** the caller wants to read the summary or a section without re-running the tool, **Then** a dedicated query tool returns the summary or the requested slice based on the file path

---

### User Story 3 - Browser Crash Automatically Recovers (Priority: P2)

During testing, the Chrome browser process crashes due to webpage failures, user errors, or system resource recovery. In the current version, the corresponding instance enters a "zombie state", and all subsequent tool calls return the original puppeteer exception stack trace; users must manually close and rebuild the instance to continue testing. After strengthening, the system can automatically perceive disconnections, reconnect according to strategies, or rebuild the browser, and provide structured errors to the caller indicating recoverability.

**Why this priority**: Occurs with a lower frequency than P1/P2, but when it happens, the user experience is extremely poor and unexpected. It belongs to "long-tail stability" and should be handled after the first two items.

**Independent Test**: Start an instance and manually terminate the Chrome process to observe that the instance status changes to "dead" within 5 seconds, when calling any page tool, it receives a structured error (containing error code and recovery suggestion) instead of an exception stack trace, and when the recovery tool is called, the instance resumes work on the original configuration.

**Acceptance Scenarios**:

1. **Given** an instance launched by this service, **When** the browser process is terminated externally, **Then** the system marks the instance as unhealthy and notifies the client within a few seconds, and subsequent tool calls return a structured error (containing error code and recovery suggestion) instead of an exception stack trace
2. **Given** an instance connected to a remote browser, **When** the CDP connection is momentarily disrupted due to network jitter, **Then** the system automatically reconnects according to an exponential backoff strategy, and recovers without user intervention
3. **Given** multiple unsuccessful reconnections, **When** the user queries the health status of all instances, **Then** the system returns the status of each instance, the latest error, and a list of executable recovery actions
4. **Given** an instance that is permanently unavailable, **When** the user calls the rebuild instance tool, **Then** the system re-launches the browser using the original configuration, retains user data directory, and restores to a usable state

---

### User Story 4 - Default Heap Capacity Supports Common Workload (Priority: P3)

Ordinary users install and start the service for the first time using the default Node heap configuration (about 1.5 GB). In the scenario of multiple instances in parallel with moderate interaction, even if the aforementioned optimizations are already effective, there is still a risk of exceeding OOM due to unanticipated factors from third-party dependencies or large DOM elements. Strengthened after, the service itself ensures that the required heap capacity is met at startup without users needing to modify mcps.json or environment variables; it actively monitors memory water levels and triggers warnings and self-protection when approaching the upper limit.

**Why this priority**: This is the "safety net" for the first three items. Without the first three the service crashes deterministically; without the fourth it crashes only occasionally. This item has the lowest priority but must be present to avoid regression.

**Independent Test**: Start the service without setting any environment variables, check the actual effective heap upper limit is no less than 4 GB; simulate the memory usage process, verify the memory warning and self-protection behavior as designed.

**Acceptance Scenarios**:

1. **Given** the user has not configured any memory-related environment variables, **When** the service starts, **Then** the actually effective heap upper limit is no less than the default safe value, and a clear explanation of the current heap configuration is included in the log
2. **Given** the user explicitly specifies the heap size through command-line parameters, **When** the service starts, **Then** the command-line configuration takes precedence, and a warning is given when the value exceeds the physical memory safety threshold
3. **Given** the actual heap usage rate continues to rise, **When** it exceeds the warning threshold, **Then** the system outputs a warning to standard error and tries to release resources actively
4. **Given** the system detects extremely high memory pressure, **When** it is about to trigger an OOM, **Then** the system writes a crash log (containing active instances, recent memory samples, and possible causes) before crashing to facilitate subsequent investigation

---

### Edge Cases

- **Extreme Long Lifecycle Sessions**: Instances that run for over 24 hours should not lose important recent records due to buffer elimination. Elimination metrics MUST be visible to the caller
- **Single Extremely Large Record**: A single console output can reach dozens of MB (e.g. printing a huge object); the system MUST individually truncate and mark such a record, and not let it bloat the buffer
- **Insufficient Disk Space**: When an artifact fails to write due to insufficient disk space, the system MUST return a clear structured error rather than silently losing data or crashing
- **Multiple Concurrent Instances with the Same Artifact Directory**: When multiple instances share an artifact directory, file naming MUST avoid collisions
- **Continuous Reconnection**: When the browser keeps exiting abnormally, automatic reconnection MUST have an upper bound (circuit breaker) to avoid endless restart loops and host exhaustion
- **Cross-Platform Paths**: On Windows / macOS / Linux, the artifact directory, file paths, and temporary files MUST have consistent semantics (path separators, temp dir resolution, legal filename characters)
- **Heap Configuration Conflicts**: When the user has explicitly set the heap parameter via an external environment variable, the service MUST NOT silently override it; the precedence order MUST be clearly documented
- **Connecting to an External Browser**: When connected to an external browser (not spawned by this service), the "rebuild instance" semantic MUST only rebuild the debug channel and MUST NOT terminate the external process

## Requirements _(mandatory)_

### Functional Requirements

#### Buffer and Log Management (Corresponding to User Story 1)

- **FR-001**: The system MUST maintain independent console message and network request buffers for each browser instance, with a bounded size, and eliminate the earliest records upon reaching the upper limit
- **FR-002**: The system MUST provide reasonable default limits for buffers (console messages not less than 500, network requests not less than 1000), and allow users to adjust the limits at startup through configuration
- **FR-003**: The system MUST return buffer data while providing metadata such as "returned number / current retained number / total observed number / eliminated number", allowing callers to clearly perceive whether elimination has occurred
- **FR-004**: The system MUST provide filtering capabilities for buffer queries (such as by time range, URL pattern, level, etc.), avoiding returning all content at once
- **FR-005**: The system MUST cap the size of a single buffered record (default 256 KB per record, configurable), and truncate and mark `truncated=true` before writing it to the buffer to prevent a single record from bloating the buffer

#### Large Products Persistence and Response Rate Limiting (Corresponding to User Story 2)

- **FR-006**: The system MUST default to writing large artifacts (screenshots, performance traces, memory snapshots, etc.) to the artifact directory, and respond with file paths, sizes, and key summary information. To preserve backward compatibility, legacy response fields (e.g. `data`) MUST remain present in the schema; when not returning inline data the field MUST be `null` or empty and a `deprecated`/`movedTo` hint MUST point at the new path field
- **FR-007**: The system MUST distinguish two artifact directories: (a) a default **ephemeral artifact dir** under the OS temp directory isolated by process id, auto-cleaned on graceful or forced exit (SIGTERM / SIGINT / uncaughtException); (b) a **persistent artifact dir** specified by configuration that is never auto-cleaned
- **FR-008**: The system MUST enforce a uniform response-size limit for every tool (default 2 MB after JSON serialization, including base64 expansion), and on overflow automatically persist the full payload to a file and return `{ truncated: true, filePath, originalSize }`
- **FR-009**: Users MUST be able to opt into inline data for tools such as screenshots, but inline return is only permitted when the payload is below the safe threshold (default 1 MB); otherwise the system MUST return a structured error guiding the caller to use the file path
- **FR-010**: The system MUST name artifact files with both an instance identifier and a high-resolution timestamp to avoid collisions under concurrency or shared directories
- **FR-011**: The system MUST return structured errors (with reason code and recommended action) when disk space is insufficient or writing fails, rather than silently failing or crashing
- **FR-011a**: The system MUST provide a dedicated read tool for persisted artifacts (trace summary, screenshot metadata, heap snapshot overview) that accepts a file path and returns a summary or requested section, so callers can fetch detail on demand without re-running the producing tool

#### Instance Health and Self-healing (Corresponding to User Story 3)

- **FR-012**: The system MUST maintain a clear health state machine for each instance (ready, reconnecting, unavailable), recording the latest error, the last healthy timestamp, and the cumulative number of reconnects
- **FR-013**: The system MUST listen for disconnection events from the browser and the underlying debugging channel, update instance state in real time, and push a status change to the caller via the standard MCP notification channel (e.g. `notifications/resourceUpdated`) immediately upon disconnection
- **FR-014**: The system MUST automatically recover an instance by attempting to reconnect, with a default of 3 attempts and exponential backoff (1s / 2s / 4s); both retry count and backoff base MUST be configurable
- **FR-015**: The system MUST check the instance health before calling any instance-dependent tools, returning a structured error with a code indicating whether recovery is possible, and recommended actions, rather than rethrowing the underlying exception
- **FR-016**: Users MUST be able to query the health status of all instances and trigger "rebuild from original configuration" for permanently unavailable instances
- **FR-017**: The system MUST trigger a "circuit breaker" (defaulting to three consecutive failures) for instances that repeatedly fail to reconnect, disabling automatic reconnection and requiring manual intervention
- **FR-018**: For instances connected to external browsers, the "rebuild" semantic MUST only rebuild the debug channel, not attempting to operate the external process's life cycle

#### Heap Memory and Crash Protection (Corresponding to User Story 4)

- **FR-019**: The system MUST detect the current heap upper limit at startup, and if it is below the built-in default safe value (not less than 4 GB), restart itself as a child process and apply a safe heap configuration
- **FR-020**: The system MUST provide a priority hierarchy of "command-line argument > environment variable > built-in default value" for heap configurations, and not override when the user has explicitly specified a value
- **FR-021**: The system MUST issue a warning and automatically downgrade to the safe value when the configured heap exceeds the physical memory safety proportion to avoid crashing the system
- **FR-022**: The system MUST sample process memory usage on a fixed interval (default every 60 s); when heap utilization exceeds the warning threshold (default 80 %) it MUST emit a warning to stderr, and when it exceeds the danger threshold (default 95 %) it MUST actively release resources (e.g. close idle instances). Both thresholds and the sampling interval MUST be configurable
- **FR-023**: The system MUST capture fatal OOM-class errors and, before exiting, write a crash log (active instance summary, recent memory samples, last several tool calls) to a known location for subsequent investigation

#### Cross-Platform & Observability

- **FR-024a**: The artifact directory, file paths, and temporary files MUST behave with consistent semantics across Windows / macOS / Linux (path separator handling, temp directory resolution, legal filename characters); paths returned in responses MUST be absolute and normalized for the host OS
- **FR-024b**: The system MUST expose runtime observability data — buffer occupancy per instance, instance health snapshot, and most recent memory samples — through both periodic structured log lines and an on-demand query tool, so operators can diagnose without attaching a debugger

#### General Constraints

- **FR-024**: All new configuration items MUST support both command-line parameters and environment variables, and the documentation MUST clearly explain their precedence
- **FR-025**: All changes MUST keep existing tool **schemas** backward compatible: existing fields MUST remain in the response shape (even if empty) so that old clients continue to parse without crashing. Default behaviour changes (e.g. screenshots no longer returning inline base64 by default) MUST be called out in the response metadata, the changelog, and the migration guide; clients that need the legacy payload MUST be able to opt back in via the documented switch
- **FR-026**: All structured errors MUST include a uniform error code, a human-readable explanation, a flag indicating whether automatic recovery is possible, and a suggested next action

### Key Entities

- **Instance**: An independent browser session context that carries pages and buffered data. Key attributes: identifier, health state, latest error, cumulative reconnect count, user data directory, and `spawnedByService` (true if this service launched the browser, false if connected to an external `--browser-url`)
- **Bounded Buffer**: A bounded FIFO store maintained per instance and per record type (console / network). Key attributes: upper limit, current count, total written count, eliminated count, per-record size cap
- **Artifact**: A persisted large output (screenshot, trace, heap snapshot, oversized response). Key attributes: owning instance, producing tool, file path, size, creation time, summary, and `lifetime` ∈ { `ephemeral`, `persistent` } indicating whether the file lives in the auto-cleaned ephemeral artifact dir or in the user-specified persistent artifact dir
- **Health Event**: A state-transition record in the instance lifecycle. Key attributes: timestamp, source (disconnection / reconnection / circuit-breaker / rebuild), and contextual information

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: Under a synthetic load of 5 console messages and 5 network requests per second, a single instance runs continuously for 1 hour with total RSS growth ≤ 200 MB (under the current version, the same load triggers OOM in ~30 minutes)
- **SC-002**: Across the standard tool-call regression suite (≥ 1000 calls covering all tools), the serialized response size is ≤ 100 KB at the 99th percentile, and **no** tool produces an inline response exceeding 2 MB
- **SC-003**: From external termination of the browser process to the moment the system marks the instance as unavailable and emits the MCP notification, end-to-end latency is ≤ 5 seconds
- **SC-004**: In the standard "WS jitter" test (programmatically dropping the CDP WebSocket 100 times while the browser process stays alive), automatic reconnection succeeds in ≥ 95 % of trials, and median recovery latency is ≤ 15 seconds
- **SC-005**: A first-time user starting the service with default parameters obtains an effective V8 old-space limit of ≥ 4 GB without any additional environment configuration
- **SC-006**: In the standard 8-hour soak test (mixed navigation, screenshots, network capture across ≥ 3 instances), the service completes the run without any manual restart
- **SC-007**: The existing tool-call regression suite passes 100 % unchanged after the upgrade. Where default response shape changes (e.g. screenshots), the legacy field remains present in the schema and an opt-in switch restores the legacy payload; this constitutes schema-level backward compatibility, not byte-for-byte response equivalence
- **SC-008**: Whenever a fatal crash occurs, the crash log is written successfully in 100 % of cases and contains sufficient context (active instances, recent memory samples, recent tool calls) to locate the cause

## Assumptions

- Target users are mainly engineers who remotely automate browsers using AI editors or CI pipelines
- The hosting environment typically has at least 8 GB of physical memory and several GB of available disk space; support for extremely small specifications is not within the scope of this range
- Users pay more attention to "recent logs" than to "complete historical logs"; a lossy elimination strategy is acceptable
- Large volumes of products written to disk are consumed and cleaned up by the client or upper layer calling party, while this service is only responsible for generating and accessibility
- The client (such as an AI editor) has the ability to consume structured errors and present them to the user; even if the client does not recognize the new error code, it should fall back to a general error display without crashing
- Any existing constraints on concurrent instances, Node version requirements, etc., remain unchanged; this effort focuses only on stability enhancements
- When involving externally managed browsers (such as `--browser-url` specified), the process lifecycle is managed externally, and this service only ensures the robustness of the debug channel
