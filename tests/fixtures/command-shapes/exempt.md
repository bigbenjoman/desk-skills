# The exemption marker

```bash
nohup ./driver.sh >> /tmp/driver.log 2>&1 &   # shape-ok: the log must outlive the worktree
echo x >> /tmp/no-reason.log   # shape-ok:
```
