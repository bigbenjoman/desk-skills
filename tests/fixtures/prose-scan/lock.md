# End-to-end runs

```bash
~/.claude/desk/bin/with-lock.sh browser --cwd <DIR> -- <§4 E2E tests>
~/.claude/desk/bin/with-lock.sh browser --cwd <DIR> -- <e2e CMD> --grep @billing
```

A suite runs under `with-lock.sh test`, its items from `desk-env cmds test-cmd`.
