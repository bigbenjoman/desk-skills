# desk-clearance phase 2: Read the lanes

Read at the start of phase 2, or earlier where the core's Phases section says. The config, ownership, what config
§3 decides, the merge bar, parking and the red flags every phase shares are in `../SKILL.md`, already
loaded.

### 2. Read the lanes

The axis is **outstanding reviewer feedback**, never whether Request changes was clicked. A
reviewer who comments without a verdict still has to be answered. Outstanding means an unresolved
thread, or a review body or comment newer than the author's last reply or push.

| | Approved | Not approved |
|---|---|---|
| **Feedback outstanding** | **3A — interrupt, highest priority** | **3B — work it, then merge or hand back** |
| **Nothing outstanding** | 3C — merge lane | 3D — merge lane if the bar is the gate; else leave it |

3A first: no human is left in its path, so threads closed means merged as soon as CI is green. Under the
strict bar, 3B waits on the reviewer after hand-back; under the gate bar, 3B merges once worked
unless a `CHANGES_REQUESTED` stands, which goes back to that reviewer.

Do not chase a PR nobody has reviewed; under the strict bar, do not touch it.
