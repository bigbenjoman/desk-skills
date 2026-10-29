# Neon consumption history fixture

`consumption-history-v2-projects.docs.json` is Neon's own documented example response for
`GET https://console.neon.tech/api/v2/consumption_history/v2/projects`, copied verbatim from
neondatabase/website `content/docs/guides/consumption-metrics.md` (fetched 2026-10-29). It is not a
recorded reply from a live account.

What the docs say about the shape:
- Query: `from`, `to` (RFC 3339, rounded to granularity), `granularity` (`hourly` last 168 h, `daily`
  last 60 days, `monthly` last year), `org_id`, `metrics` (comma-separated: `compute_unit_seconds`,
  `root_branch_bytes_month`, `child_branch_bytes_month`, `instant_restore_bytes_month`,
  `snapshot_storage_bytes_month`, `public_network_transfer_bytes`, `private_network_transfer_bytes`,
  `extra_branches_month`). Auth: `Authorization: Bearer <NEON_API_KEY>`.
- `projects[].periods[].consumption[].metrics[]` holds `{ metric_name, value }`; `pagination.cursor`
  pages through projects.
- Metrics with a value of zero may be omitted, so a reader must treat a missing metric as 0.
- The legacy `GET /consumption_history/projects` (metrics such as `active_time_seconds`) is a
  different endpoint; this is the v2 one for usage-based plans.
