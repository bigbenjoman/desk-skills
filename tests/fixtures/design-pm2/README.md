# Prana Motion design fixtures

Trimmed copies of two Claude Design artifacts, for `tests/test_design.mjs`.

- `deck/project/`: a Slides deck snapshot (version 1792850658-97df of
  https://claude.ai/artifact/2v9EQUrnCJgQeRNhEBUK53, reconstructed from the hand-made copy in
  bigbenjoman/pranamotion `docs/design/PM-2-deck/`). Three slides verbatim (`short` has speaker
  notes, `who` has no image, `gaps` has two `data-crop` images); `deck.json` with its `order` cut to
  those three and its `sections` dropped. The two `/_blob/<id>` images are not copied: the test
  writes a 1x1 PNG under each id.
- `canvas/project/canvas.json`: verbatim from https://claude.ai/artifact/MEzqmgF7kAduPcxbu8djtL,
  version 1792843406-fc94, to tell a canvas snapshot from a deck.
