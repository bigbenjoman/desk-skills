# desk-setup costs: where each repo is billed

Read for `/desk-setup costs`, which runs only this. The Modes table in `../SKILL.md` names this file
for it. It reads and writes one file, `~/.config/desk/costs.md`, beside the machine profile and
shared by every repo, and changes nothing else: no repo config, no settings.

One GitHub account, Vercel team or AWS profile often bills several repos, and some bills belong to
no repo in desk. The file records, for each name, its GitHub repo and account, its Vercel team (id,
slug and plan) and projects, and its AWS profile, plus the monthly GitHub Actions budget and any AWS
credit balance. It records where each supplier's login lives (`gh`, the Vercel CLI's auth file, the
AWS config), never a token.

1. **Show what this computer can see**, then the proposal:

   ```bash
   desk-env costs detect
   desk-env costs propose
   ```

   `detect` lists each configured repo's GitHub repo and the account `gh` is signed in to, the
   Vercel teams and projects the Vercel CLI's login can see, and the profiles in the AWS config. A
   supplier it cannot read (Vercel signed out, no AWS config) is said on its own line; say it and
   carry on with the rest. `propose` shows each source against a name, as a table in the
   conversation. Say in one line how names were matched: a source whose name contains a configured
   repo's (`prninja-admin` is `pr-ninja`) goes to that repo, and anything else gets a name of its own
   with no repo in desk. A Vercel team whose projects go to more than one name has its plan saved as
   shared. A GitHub repo in an account other than the one `gh` is signed in to is saved as not
   readable.

2. **Ask what to change, then the two figures only the user holds.** In one `AskUserQuestion` call:
   whether the names are right (Recommended: as proposed), the monthly GitHub Actions budget in
   dollars, and, for each AWS profile, any credit balance and the date the credits end. Never guess
   a figure: a budget or credit nobody gave is left unset. Each answer becomes an option on the next
   `propose`:

   | Answer | Option |
   |---|---|
   | a source under another name | `--name <source>=<name>`, the source as the table's SOURCE column gives it |
   | a source that is not theirs to track | `--drop <source>` |
   | the Actions budget | `--actions-budget <usd>` |
   | a profile's credit | `--credit <profile>=<usd>@<YYYY-MM-DD>` (the date the credits end) |

   Run `desk-env costs propose` with every option and show the result again. Repeat until they
   confirm it.

3. **Write only on a yes**, with the same options:

   ```bash
   desk-env costs write --actions-budget 50 --credit fansurge=1200@2027-03-31
   ```

   It overwrites the file, keeping the previous copy as `costs.md.bak`. A credit is stored with the
   day it was entered. **A no, or no answer, writes nothing**: say that no cost sources were saved.

**Run again** to see the saved list: saved sources keep their names, credits and budget, and every
team, project or profile found since is marked `new`; one no longer found is marked `not found` and
kept until dropped. Nothing changes until they confirm and `write` runs. `desk-env costs show`
prints the saved file (`--json` for each name's sources as data), and a missing file is "no cost
sources", never an error.
