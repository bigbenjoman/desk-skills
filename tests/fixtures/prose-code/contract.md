# Tagged JSON examples

A results file whose finding names an agent as its refuter:

<!-- contract: results -->
```json
{ "sha": "0123456789abcdef0123456789abcdef01234567", "round": 1, "gaps": 0, "skipped_files": 0,
  "seats": [ { "role": "correctness", "agent": "lena-code-reviewer", "vendor": "claude", "status": "ran" } ],
  "findings": [ { "id": "F1", "seat": "correctness", "severity": "P1", "result": "CONFIRMED", "refuted_by": "lena-code-reviewer" } ] }
```

The same file refuted by a vendor:

<!-- contract: results -->
```json
{ "sha": "0123456789abcdef0123456789abcdef01234567", "round": 1, "gaps": 0, "skipped_files": 0,
  "seats": [ { "role": "correctness", "agent": "lena-code-reviewer", "vendor": "claude", "status": "ran" } ],
  "findings": [ { "id": "F1", "seat": "correctness", "severity": "P1", "result": "CONFIRMED", "refuted_by": "codex" } ] }
```

A park file with a field it does not declare, then one with only its own:

<!-- contract: park -->
```json
{ "question": "Which plan?", "colour": "red" }
```

<!-- contract: park -->
```json
{ "question": "Post this comment? awaiting approval", "approve": { "kind": "jira-comment", "target": "ABC-1", "body": "Done." } }
```

A contract no validator has, and a block too broken to read:

<!-- contract: invoice -->
```json
{ "total": 3 }
```

<!-- contract: park -->
```json
{ "question": "Which plan?", }
```

An untagged block is never read:

```json
{ "question": "Which plan?", "colour": "red" }
```
