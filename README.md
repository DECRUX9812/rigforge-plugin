# Rigforge

**A build studio for robots and printed machines, inside Hermes Desktop.**

![Rigforge studio](docs/screenshots/hero.png)

Schematik answers *"what circuits do I wire"*. Rigforge answers *"what do I build"* —
a complete machine from one brief:

| | |
|---|---|
| geometry | posed 3D assembly, orbit/zoom, joint sliders, real forward kinematics, exploded view |
| mechanics | joint torque cascade → servo/belt-stage selection, wheel torque → motor choice, link bending + deflection |
| power | per-rail typical and stall current → pack → runtime, wire gauge, fuse and connector sizing |
| electronics | pin map that refuses strapping pins and the flash bus, PCA9685 channels, UART bus reservation |
| firmware | Arduino skeleton generated from the same pin map — homing, encoders, gait loops |
| manufacturing | BOM with prices + SKUs, mass, print grams/hours, per-part STL pack (zip), OpenSCAD, assembly order |

The engine is deterministic and offline: the same brief always produces the same
machine, and every number is computed (not narrated). The agent designs; the maths
is the studio's.

## Anybody can build

- **Click a machine card** — pick a robot dog, a gripper, a humanoid; the whole
  spec appears instantly. No typing required.
- **Or type one sentence and press Enter** — *"a robot car that maps my room"*
  is a complete brief.
- Every control says what it does in plain words, and the readiness block leads
  with a sentence — *"Ready to build — every engineering check passed."* — before
  the engineering tables a grown-up might want.

## Archetypes

`arm` · `rover` · `quadruped` · `gripper` · `humanoid` (23-joint biped, two servo
buses) · `robot` (mobile manipulator: 4WD base + arm + pan head) · `gadget` (ESP32
desk device, parts chosen from the mission text: weather → BME280, plant → soil
probe, clock → TFT, …)

| | |
|---|---|
| ![Quadruped posed](docs/screenshots/quad.png) | ![Gripper closed](docs/screenshots/gripper.png) |
| ![Rover](docs/screenshots/rover.png) | ![Posed](docs/screenshots/posed.png) |

## The agent half

Two tools, one small state dir (`$HERMES_HOME/rigforge/*.json`):

| tool | does |
|---|---|
| `rigforge_build` | parses a sentence or a params object, queues the build, returns the brief + a `::rigforge{…}` directive |
| `rigforge_state` | reads back what the studio computed last: cost, mass, print hours, peak amps, readiness checks |

The loop is two files and no polling from Python:

```
agent --rigforge_build--> queue.json --GET /api/plugins/rigforge/queue--> studio page
agent <--rigforge_state-- state.json <--POST /api/plugins/rigforge/state-- studio page
```

Backend routes (`dashboard/plugin_api.py`, mounted at `/api/plugins/rigforge/`):

```
GET  /health
GET  /queue?peek=1&limit=5     read-only
GET  /queue?limit=5            drain (the page's poller — each request applied once)
POST /queue                    {"brief": …, "note": …}
GET  /state
POST /state                    the studio's computed summary
```

Payloads are bounded on the way in (text lengths, check count, clamped numbers), so
neither side can grow the store without limit.

## Where it lives

- UI page `/rigforge` + a sidebar row + five command-palette rows
- `::rigforge{brief={…}}` transcript directive — the **agent → plugin** door: the model
  writes one line in chat and a "load into studio" card appears
- **ASK HERMES** on the page stages a structured prompt with the live spec in the
  composer (plugin → agent), and tells the agent to reply with the same directive
- `rigforge_build` / `rigforge_state` tools + the queue/state routes above — the
  agent can start a build without a chat round-trip, and read the result back
- the topbar's **AGENT** chip is the honest liveness read: LINKED only when the
  plugin backend actually answered

## Install

```bash
node build.mjs                       # src/*.js → plugin.js (single file, no deps)
cp plugin.js ~/.hermes-webapp/desktop-plugins/rigforge/plugin.js   # webapp
cp plugin.js ~/.hermes/desktop-plugins/rigforge/plugin.js          # native desktop
```
Then reload the app (Cmd/Ctrl-R). Enabled by default; toggle in Capabilities ▸ Plugins.

## Develop

```
src/00-head.js        imports + why-this-exists
src/10-parts.js       the part catalogue (prices, torque, current, mass)
src/15-design.js      design builder + printed-volume model (wall shell, not solid)
src/20..23-*.js       archetype generators
src/30-analysis.js    pin map, power budget, mass/cost/print, readiness checks
src/35-firmware.js    Arduino generation + assembly steps
src/40-geometry.js    FK pass, meshes, STL / OpenSCAD / markdown / CSV exporters
src/45-compose.js     brief parsing, presets, agent prompt, directive parsing
src/50-viewport.js    software 3D renderer (painter's algorithm on 2D canvas)
src/55-styles.js      the studio's palette + element factory
src/56-panels.js      the seven spec tabs
src/60-page.js        the page
src/70-register.js    routes / nav / palette / directive / settings
```

Tests (all run without the app):

```bash
node tests/engine-smoke.mjs     # numbers per archetype
node tests/render-ssr.mjs       # every component through real React 19 (SSR)
node tests/make-preview.mjs     # bundle a standalone preview page
node tests/shoot.mjs            # headless screenshots of every tab
node tests/functional.mjs       # pose a joint, export an STL, verify the bytes
HERMES_HOME=$(mktemp -d) python3 tests/agent_half.py   # tools, store, HTTP routes
```

## Gotchas worth remembering

- `jsx` must receive `key` as the **third argument**; spreading it warns in React 19.
  The local `h()` factory handles that.
- A camera basis needs `up = back × right`. The byte-simple `[sy·sp, -cy·sp, cp]`
  is not orthogonal and shifts the whole frame downward — it looks like a CSS bug.
- The agent half's CLI verb (`hermes rigforge …`) is skipped under host isolation —
  drive it through `rigforge_build` or the routes instead.
- Desktop plugins may import only `@hermes/plugin-sdk`, `react`, `react/jsx-runtime`.
  The area constants (`ROUTES_AREA`, `SIDEBAR_NAV_AREA`, `PALETTE_AREA`,
  `TRANSCRIPT_DIRECTIVE_AREA`) and `__HERMES_PLUGIN_SDK__` are present in the live
  bundle — grep `apps/desktop/dist-webapp/assets/*.js` before relying on a name.
