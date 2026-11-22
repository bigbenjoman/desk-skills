# Scripts

```bash
node ~/.claude/desk/bin/no-such-script.mjs ABC-123
node ~/.claude/desk/bin/pass.mjs --once
bash $DESK_SKILLS_DIR/desk-disk/bin/disk-scan.sh
```

Run `scripts/make-thing.sh` first, then `desk/bin/merge-log.mjs`.

Desk ships `./install.sh`, `~/.claude/hooks/desk-handoff.py`, `scripts/desk/pre-push.sh` and
`claude_activity.py`; `…/merge-driver.sh` is elided and `tests/run.sh` is in this repo.
