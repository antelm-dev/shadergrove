# Runbooks

Step-by-step procedures for operating, deploying and releasing Shadergrove. A runbook says when to
use it, what you need first, the exact steps, how to verify the result and how to roll back.

Each runbook declares an `area` and a `last_verified` date. Set `last_verified` only after running
the procedure end to end. In Obsidian, [runbooks.base](runbooks.base) sorts them so the stalest
come first.

| Runbook                                                            | Area        |
| ------------------------------------------------------------------ | ----------- |
| [Staging on vps-lab-01](staging.md)                                | infra       |
| [Website on vps-lab-01](website-vps.md)                            | infra       |
| [Staging VPS security](vps-security.md)                            | security    |
| [Secret rotation](secret-rotation.md)                              | security    |
| [Deploying Shadergrove with accounts](deploying-authentication.md) | deploy      |
| [PR preview environments](pr-previews.md)                          | deploy      |
| [Deployment rollback](deployment-rollback.md)                      | deploy      |
| [Database backup and restore](database-backup-restore.md)          | data        |
| [Release readiness](release-readiness.md)                          | release     |
| [Releasing](../../RELEASING.md)                                    | release     |
| [Dependency maintenance](dependency-maintenance.md)                | maintenance |

To add a runbook, start from [the runbook template](../templates/runbook.md) and add it to the
table above.
