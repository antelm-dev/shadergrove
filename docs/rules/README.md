# Rules

Canonical rules for everyone who changes this repository, human or agent. Tool-specific files
(`AGENTS.md`, `.cursor/rules/shadergrove.mdc`, `.cursor/BUGBOT.md`) point here instead of
restating them.

Each rule note declares `applies_to` (which surfaces) and `enforced_by` (which check, if any,
fails when the rule is broken). A rule enforced only by `review` or `convention` is one a reviewer
has to catch by hand. In Obsidian, [rules.base](rules.base) lists them by enforcement.

| Rule                                                           | Enforced by                                      |
| -------------------------------------------------------------- | ------------------------------------------------ |
| [Workspace layout and commands](workspace.md)                  | convention                                       |
| [Code quality](code-quality.md)                                | oxfmt, oxlint, tsc, CI                           |
| [Generated files](generated-files.md)                          | `check:ipc`, review                              |
| [Runtime and IPC boundaries](ipc-boundary.md)                  | oxlint, `check:ipc`, review                      |
| [User-facing text](i18n.md)                                    | `check:i18n`, review                             |
| [Validation at application boundaries](boundary-validation.md) | review                                           |
| [Persisted state compatibility](persisted-state.md)            | review                                           |
| [Code review priorities](code-review.md)                       | review                                           |
| [Branches, versions and releases](release.md)                  | release-please, `check:plugins`, budgets, review |

Feature planning and agent runs follow [the planning guide](../planning/README.md).

To add a rule, start from [the rule template](../templates/rule.md), keep one rule per note, and
add it to the table above.
