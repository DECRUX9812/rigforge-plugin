import { loadEngine } from '/tmp/rf-tm/tests/lib-engine.mjs'
const A = loadEngine()
const P = A.PRESETS.find(p => p.brief.archetype === 'humanoid') || A.PRESETS.find(p => /hum/i.test(p.id))
const { design, analysis } = A.composeDesign({ ...P.brief })
const g = A.createGaitTeleop(design)
console.log(JSON.stringify({
  id: P.id,
  maxStepM: g.maxStepM,
  nodes: design.nodes.length,
  joints: design.joints.length,
  analysisLeg: analysis && analysis.leg ? analysis.leg : null,
}, null, 1))
