# Output, not commands

```
cd /tmp && echo x > /tmp/y
f() { echo "x"; }
```

```text
{ a; b; } > /tmp/out
cat > notes.md <<'EOF'
```

```console
$ desk-env mem status
cd /tmp && f() { echo "x"; } >> /tmp/printed-output
```
