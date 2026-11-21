# Two JSON examples

An untagged one:

```json
{ "state": "parked", "marker": "AUTOPILOT_PARK", "file": "$DESK_STATE/parks/ABC-1.json" }
```

A tagged one:

<!-- contract: park-file -->
```json
{
  "question": "AUTOPILOT_PARK: which?",
  "state": "parked"
}
```
