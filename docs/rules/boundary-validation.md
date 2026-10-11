---
type: rule
applies_to: [studio, server, desktop, mcp]
enforced_by: [review]
---

# Validation at application boundaries

Treat validation, sanitization and size limits at application boundaries as safety-critical. This covers shader sources, project files, API payloads, IPC messages and MCP input.

Validate at the boundary where untrusted data enters, not deep inside the code that consumes it. A change that loosens or removes a limit needs an explicit reason in the pull request.
