# A command left open never hides the lines after it

```bash
echo "$(
  git log -1  # the newest
)"
echo x > /tmp/after-substitution
echo Ben's notes
f() { :; }
```
