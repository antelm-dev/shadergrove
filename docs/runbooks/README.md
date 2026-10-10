# Runbooks

Step-by-step procedures for operating, deploying and releasing Shadergrove. A runbook says when to
use it, what you need first, the exact steps, how to verify the result and how to roll back.

Each runbook declares an `area` and a `last_verified` date. Set `last_verified` only after running
the procedure end to end. In Obsidian, [runbooks.base](runbooks.base) sorts them so the stalest
come first.

| Runbook                                                            | Area        |
| ------------------------------------------------------------------ | ----------- |
| [Deploying Shadergrove with accounts](deploying-authentication.md) | deploy      |
| [Website on vps-lab-01](website-vps.md)                            | infra       |
| [Release readiness](release-readiness.md)                          | release     |
| [Releasing](../../RELEASING.md)                                    | release     |
| [Dependency maintenance](dependency-maintenance.md)                | maintenance |
| [Database backup and restore](database-backup-restore.md)          | data        |
| [Deployment rollback](deployment-rollback.md)                      | deploy      |
| [Secret rotation](secret-rotation.md)                              | security    |

Operational notes not yet moved into this folder: [staging](../staging.md),
[PR previews](../pr-previews.md) and [VPS security](../vps-security.md).

To add a runbook, start from [the runbook template](../templates/runbook.md) and add it to the
table above.
