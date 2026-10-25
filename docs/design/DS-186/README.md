# Design canvas DS-186

Saved by `desk-design` from <https://claude.ai/artifact/N2EzmaE9zM6Ty3GaBdAcVQ>, version 1792692450-5baf, fetched 2026-10-22T18:14:05.486Z.
Open any board's HTML from this folder: it renders offline with the files saved beside it.
Do not edit these files by hand. When the artifact has a newer version, re-save it with
`desk-design save`, which replaces them.

| Ticket | Boards |
|---|---|
| DS-186 | all |
| DS-187 | all |
| DS-188 | all |

## Boards

canvas.json names no boards.

## support.js is not saved

The boards load `./support.js`, but the artifact does not publish that file: the Claude Design
runtime supplies it when the canvas is open on claude.ai. Offline, the boards' HTML and copy are
all here, but they render without that runtime. `desk-design save` refuses a snapshot with a
missing reference, so this folder was copied in and its manifest written with `desk-design write`.
