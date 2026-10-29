# Cost sources

Which GitHub repos, Vercel teams and projects and AWS profiles bill each name, for every repo on
this computer. Written by `desk-env costs write` once you confirmed the proposal in
`/desk-setup costs`; run it again to see what is new. Repo `none` is a name with no repo in desk.
No token is kept here: Logins says where each supplier's login lives.

## GitHub

| Name | Repo | GitHub repo | Account | Readable |
|---|---|---|---|---|
| `desk-skills` | `bigbenjoman__desk-skills` | `bigbenjoman/desk-skills` | `bigbenjoman` | `yes` |
| `forewatt` | `bigbenjoman__forewatt` | `bigbenjoman/forewatt` | `bigbenjoman` | `yes` |
| `gygg-platform` | `bigbenjoman__gygg-platform` | `bigbenjoman/gygg-platform` | `bigbenjoman` | `yes` |
| `pr-ninja` | `bigbenjoman__pr-ninja` | `bigbenjoman/pr-ninja` | `bigbenjoman` | `yes` |
| `pranicuk` | `pranichealinguk__pranicuk` | `pranichealinguk/pranicuk` | `pranichealinguk` | `no` |
| `voicepa` | `bigbenjoman__voicepa` | `bigbenjoman/voicepa` | `bigbenjoman` | `yes` |
| `yield-index` | `bigbenjoman__yield-index` | `bigbenjoman/yield-index` | `bigbenjoman` | `yes` |

## Vercel

| Name | Repo | Team id | Team | Plan | Plan shared | Projects |
|---|---|---|---|---|---|---|
| `forewatt` | `bigbenjoman__forewatt` | `team_KOo6OJNsSYLcB49QcY3hNJCc` | `ben-lavenders-projects` | `pro` | `yes` | `forewatt` |
| `pr-ninja` | `bigbenjoman__pr-ninja` | `team_YoeHAE4DdusnGIPLdmBGVmxh` | `pr-ninja` | `pro` | `no` | `pr-ninja` |
| `voicepa` | `bigbenjoman__voicepa` | `team_WgS8cmiltn5LhpHyiyBLNRxm` | `voice-pa` | `pro` | `no` | `portal, staging, voicepa` |
| `yield-index` | `bigbenjoman__yield-index` | `team_KOo6OJNsSYLcB49QcY3hNJCc` | `ben-lavenders-projects` | `pro` | `yes` | `yield-index` |

## AWS

| Name | Repo | Profile | Credit (USD) | Credits end | Credit entered |
|---|---|---|---|---|---|
| `fansurge` | `none` | `fansurge` | `none` | `none` | `none` |
| `forewatt` | `bigbenjoman__forewatt` | `forewatt` | `none` | `none` | `none` |
| `pr-ninja` | `bigbenjoman__pr-ninja` | `prninja-admin` | `none` | `none` | `none` |
| `voicepa` | `bigbenjoman__voicepa` | `voicepa-admin` | `none` | `none` | `none` |
| `yield-index` | `bigbenjoman__yield-index` | `yieldindex` | `250` | `2027-03-31` | `2026-10-20` |

## Budget

| Key | Value |
|---|---|
| `actions-budget-usd` | `600` |

## Logins

| Supplier | Where |
|---|---|
| `github` | `gh` |
| `vercel` | `~/Library/Application Support/com.vercel.cli/auth.json` |
| `aws` | `~/.aws/config` |
