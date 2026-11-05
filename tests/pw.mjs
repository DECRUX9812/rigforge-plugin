import { loadEngine } from '/tmp/rf-tm/tests/lib-engine.mjs'
const A = loadEngine()
const env = { surface: 'hardwood', slopeDeg: 0, course: 'stairs' }
for (const arch of ['quadruped', 'humanoid']) {
  const p = A.PRESETS.find(x => x.brief.archetype === arch)
  const { design } = A.composeDesign({ ...p.brief })
  const gait = A.createGaitTeleop(design)
  const at = A.createAutotest(gait)
  at.start()
  let actual = design.joints.map(() => 0)
  for (let i = 0; i < 60 * 25 && at.running; i++) {
    const c = at.tick(1 / 60)
    const r = gait.locomote(c, 1 / 60, actual, env)
    if (r && r.pose) actual = r.pose
  }
  const ob = at.results.find(r => r.id === 'obstacle')
  console.log(arch, 'maxStep', gait.maxStepM.toFixed(4), '->', ob && ob.pass, '|', ob && ob.detail)
}
