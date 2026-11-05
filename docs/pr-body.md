## Summary

Adds **rigforge** to the plugin catalog — a deterministic, offline build studio for
robots, printed machines and controller boards that runs inside Hermes Desktop.

Say one sentence (or click a card) and get the whole build:

- **Posed 3D geometry** with real forward kinematics, joint sliders, exploded view,
  orbit/zoom — and the mesh on screen is the mesh in the STL
- **Mechanical sizing**: joint torque cascade → real servo selection, with a belt
  stage when no servo in the catalogue can do it, and an explicit *out of scope*
  when even that is not enough
- **Power**: per-rail typical and stall current → pack → runtime, wire gauge sized to
  the stall case with its ampacity printed, a fuse that never exceeds its wire, and
  parallel feeds when one lead cannot carry the rail
- **Wiring**: ESP32 pin map that refuses strapping pins, the flash bus and USB, and
  reserves UART pairs for servo buses
- **Firmware**: an Arduino sketch generated from that same pin map, with a channel
  count taken from the BOM — not from a guess
- **Manufacturing**: priced BOM with SKUs, mass, print grams/hours, and per-part STL
  packs that are laid flat, centred on Z=0 and split to fit *your* printer bed
- **Boards too**: design a controller board with placements, per-part solder verdicts
  and a board pack (BOM + centroid/CPL + spec) for a fab or assembly house
- **Trust surfaces**: *show the working* opens any headline number into its formula and
  its inputs; *before/after* recomputes two builds and says what a change actually did
- **Sharing**: a design is a build code — `RF1-…`, about 200 characters, rebuilds
  exactly on someone else's machine, priced against their suppliers

Ten archetypes, one engine: IoT sensor node · controller board · 5-DoF arm ·
parallel gripper · rover · quadruped · 23-joint humanoid · mobile manipulator ·
ESP32 desk device · metre-scale gantry.

Two agent tools (`rigforge_build`, `rigforge_state`) plus `rigforge_prices` let Hermes
queue a build, read the studio's computed summary back, and price the BOM against the
LCSC index; a `::rigforge{...}` transcript directive hands a machine into the studio,
and the studio opens it straight into a before/after against what the user had.

### Why it is more than a prompt

The engine is deterministic and offline — the CLI can compute a whole machine without
a model call. `tests/truth.mjs` probes twenty claims against the code that produces
them (cost, mass, print time, bed fit, actuator sizing, pin map, firmware pins, STL
bytes, build codes, determinism, CPL, wiring, presets, the ENERGY control, firmware
channels, BOM totals, spec numbers, build steps), and fails the build if any of them
stops being true.

### Verification

- `node tests/truth.mjs` — 20/20 claims hold
- `node tests/engine-smoke.mjs` — all ten archetypes build, with parts/tris/STL/cost/
  mass/print/power/firmware/steps present
- `node tests/functional.mjs` — poses a joint, exports an STL, checks the byte math
- `HERMES_HOME=$(mktemp -d) python3 tests/agent_half.py` — 25/25 tools, queue, routes
- `hermes plugins validate` — passes all checks including the security scan and the
  desktop-surface rule

Demo (46 s, landscape): https://github.com/DECRUX9812/rigforge-plugin#readme — the
repo README carries current screenshots of the studio, the audit view and the board.
