# Shapes that do not prompt

```bash
echo "${HOME}/x" "${#ARR[@]}"
awk -F'\t' '{print $1}' checks.tsv
jq -n --arg b x '{body: $b, kind: "comment"}'
find . -name '*.md' -exec grep -l "TODO" {} \;
git -C <dir> status --porcelain
gh pr view <n> --json reviews --jq '.reviews[] | {state, body}'
python3 - <<'P'
def f(): return {"a": "b"}  # cd /tmp && echo x > /tmp/y
P
desk-jira md2wiki body.md \
  > body.wiki
node ~/.claude/desk/bin/pass.mjs --json   # comment: cd /tmp && echo > /tmp/x
```
