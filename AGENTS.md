# RigForge — agent notes

Robot / printed-machine design studio. Deterministic, offline, no deps.

## Layout

- `src/NN-*.js` — engine + page source, concatenated by `build.mjs` (load order = filename order)
- `web/plugin.js`, `desktop/plugin.js` — built bundles; **always rebuild after src edits** (`node build.mjs`)
- `tests/truth.mjs` — the behaviour-contract gate; every headline number is recomputed independently
- `tests/lib-engine.mjs` — exposes engine functions to tests; new engine fns must be added to its `API = {...}` list
- `tests/render-ssr.mjs`, `tests/layout-widths.mjs`, `tests/layout-widefont.mjs`, `tests/export-sweep.mjs`, `tests/scad-render.mjs` (optional, needs openscad-wasm)

## Verify before pushing

```
node build.mjs && node tests/truth.mjs && node tests/render-ssr.mjs
```

Truth count is asserted in README — keep them in sync when adding gates.

## Honesty rules (do not break)

- No silent clamps: out-of-envelope inputs must fail loudly, not pretend.
- Analysis and exports read the same triangles — DFM/STL/3MF must agree.
- `benchOverlay`/`wireOverlay`/`reachOverlay` vertex layout is `[x,y,z,r,g,b]` per vertex; a "seg" is 2 verts (12 floats).
- `tests/tmp/` is scratch — never commit probe output.

## GitHub push outage workaround (2026-11)

`git push` to this repo fails server-side: `remote: fatal error in commit_refs`, and REST `git/blobs` returns HTTP 500. Refs and `git/commits`/`contents` endpoints still work, so push via the **contents API** — one commit per changed file (squash-merge cleans history):

1. `gh api repos/DECRUX9812/rigforge-plugin/git/refs -f ref=refs/heads/<branch> -f sha=<base_sha>`
2. For each changed file: GET `contents/<path>?ref=<branch>` for the blob `sha`, then PUT `contents/<path>` with `{message, content: <base64>, sha, branch}`.

A working script lived at `~/.cache/devin/scratch/apipush/push_branch.py` (may be gone — the recipe above is enough; `gh api --input file.json` avoids arg-length limits for the 600KB bundles).
