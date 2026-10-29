/**
 * RIGFORGE — the build studio for robots and printed machines.
 *
 * Schematik answers "what circuits do I wire". Rigforge answers the harder
 * question: "what do I BUILD" — a complete machine, spec'd end to end:
 *
 *   brief → archetype + geometry (posed, orbitable, STL-exportable)
 *         → joint/motor sizing (torque, not vibes)
 *         → power budget (peak current → battery → runtime)
 *         → MCU pin map that respects real ESP32 strap/flash/ADC rules
 *         → firmware skeleton that matches the pin map
 *         → BOM with cost, mass and print time
 *         → assembly order
 *
 * WHY A PLUGIN, AND WHY DESKTOP-ONLY
 * Core has no mechanical/electrical design surface, and nothing in core
 * generates geometry, sizes a servo or exports a mesh. The SDK reaches
 * everything this needs (`ctx.storage` for the shelf, `host.composer` to hand a
 * spec to the agent, `TRANSCRIPT_DIRECTIVE_AREA` so the AGENT can hand a build
 * back into the studio by writing `::rigforge{...}`). No backend is shipped, so
 * the reachable doors are the ones used — nothing here depends on an app REST
 * route.
 *
 * The engine is deterministic and offline: the same brief always yields the
 * same machine, and the numbers are computed (torque, current, mass, runtime),
 * never narrated. The agent is the *designer*, not the calculator.
 */
import { PALETTE_AREA, ROUTES_AREA, SIDEBAR_NAV_AREA, TRANSCRIPT_DIRECTIVE_AREA, host } from '@hermes/plugin-sdk'
import { jsx } from 'react/jsx-runtime'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const ROUTE = '/rigforge'
const G = 9.80665
