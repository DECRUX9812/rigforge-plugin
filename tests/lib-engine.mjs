// Truth harness — every headline claim the product makes, probed against the
// code that produces it. Run with `node tests/truth.mjs`; exits non-zero on any
// failure, so a lie cannot ship quietly.
//
// The rule this file enforces: a claim is only a claim if something recomputes
// it independently of the function that displayed it.
import { readdirSync, readFileSync } from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = join(here, '..', 'src')

/** Load src/*.js the way build.mjs concatenates it, then export what we probe. */
export function loadEngine() {
  const code = readdirSync(srcDir)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => readFileSync(join(srcDir, f), 'utf8'))
    .join('\n')
    .replace(/^import[^\n]*\n/gm, '')
    .replace(/^export default /m, 'globalThis.plugin = ')
  const ctx = {
    console,
    TextEncoder,
    TextDecoder,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    jsx: () => null,
    jsxs: () => null,
    host: {},
    useRef: () => null,
    useMemo: (f) => f(),
    useEffect: () => null,
    useState: (v) => [v, () => null],
    useCallback: (f) => f,
  }
  vm.createContext(ctx)
  vm.runInContext(
    code + '\nglobalThis.API = { composeDesign, parseBrief, PRESETS, PARTS, MATERIALS, buildMesh, toSTL, printedPartSTLs, overhangReport, overhangTrisStats, wallReport, nodeTriangles, bedFrameTris, toCentroidCsv, encodeBuild, decodeBuild, boundsOf, printFit, toURDF, toMJCF, toBOMCsv, toSpecMarkdown, printPackReadme, toOpenSCAD, to3MF, toGLB, toSTEP, stepsFor, createDrive, createArmTeleop, createGaitTeleop, createGripTeleop, createGantryTeleop, createPowerSim, createSensorTeleop, createAutotest, solveChainIK, chainsFor, benchNodeWorld, armTipChain, armReachBound, benchCoM, benchContacts, benchSlopeMargin, benchTorqueMargins, benchReport, benchOverlay, wireOverlay, loadOverlay, reachOverlay, workspaceMap, workspaceOverlay, legWorkspaceMap, legWorkspaceOverlay, jointLoadNm, createJointSim, terrainHeight, benchRampTris, applyChassis, DRIVE_SURFACES, fixSuggestions, deskPropsTris, deskPropNear, gripBenchTris, GRIP_BENCH, POSE_PRESETS, applyPosePreset, packBedLayout, RF_PARTS: globalThis.__RF_PARTS || {} };',
    ctx,
  )
  return ctx.API
}
