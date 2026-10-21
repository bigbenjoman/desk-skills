# A shell function with a quoted brace in its body

```bash
DIR=config
jcurl() { printf 'user = "%s"\n' "$EMAIL" | curl -K - -sS "$@"; }
```
