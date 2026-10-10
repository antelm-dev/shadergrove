---
type: rule
applies_to: [studio, desktop, server]
enforced_by: [review]
---

# Persisted state compatibility

Projects, sessions, editor groups and surface layouts outlive the build that wrote them.

- When a persisted shape changes, update its schema, version, migration and validation paths together.
- Never silently discard user state that fails to load. Migrate it, or keep it and report the failure.
