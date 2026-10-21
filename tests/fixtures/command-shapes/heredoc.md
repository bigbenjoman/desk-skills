# A heredoc written to a file

```bash
cat > notes.md <<'EOF'
the body is data: cd /tmp && f() { echo "x"; } > /tmp/never-read
EOF
git add notes.md
```
