# Writes outside the working directory

```bash
echo done >> /tmp/run.log
git log --oneline > ~/commits.txt
cat header.md >> <state>/batch-notes.md
printf x > "$DESK_STATE/notes"
echo kept > out.txt
gh pr view <n> --json reviews 2>/dev/null
some-check 2>&1 | head -5
echo "a > /tmp/b is only text"
echo x >| /tmp/clobbered
jq '
  { a: "b" }
' in.json > /tmp/out.json
```
