// ── endurance power: battery SoC, bus sag, servo thermals ──────────────────
// The bench runs for minutes, not milliseconds — so the pack actually drains
// and the servos actually cook. SoC integrates the joint sim's live bus
// current (plus drive-motor draw on wheeled machines); bus voltage sags with
// state-of-charge and current; every joint's temperature rises with the
// square of its load ratio and Newton-cools toward ambient. Past 80 °C the
// joint cuts out until it cools below 75 °C — hysteresis, like the real
// thermal protector in the servo. At 2 % SoC the machine is dead until the
// battery is swapped (reset).

const PWR_AMB = 25 // °C ambient
const PWR_CUTOFF = 80 // °C servo thermal cutoff
const PWR_RECOVER = 75 // °C hysteresis floor
const PWR_DEAD = 2 // % SoC — below this the pack cannot deliver

/** Returns null for tethered builds (USB-PD, mah: 0) — infinite runtime. */
function createPowerSim(design) {
  const bat = (design.parts || []).map((p) => PARTS[p.key]).find((p) => p && p.cat === 'battery')
  if (!bat || !bat.mah) return null
  const mah = bat.mah
  const volts = bat.volts || 7.4
  const n = (design.joints || []).length
  const state = {
    soc: 100,
    vbus: volts,
    busA: 0,
    temps: new Array(n).fill(PWR_AMB),
    cut: new Array(n).fill(false),
  }
  return {
    state,
    /**
     * simState: the joint sim's state ({busA, loadNm, stallNm}).
     * extraA: drive-motor draw the joint sim cannot see (wheeled machines).
     */
    step(dt, simState, extraA) {
      const busA = ((simState && simState.busA) || 0) + (extraA || 0)
      state.busA = busA
      // mAh drained this step; SoC is a percentage of nameplate capacity
      state.soc = Math.max(0, state.soc - (busA * dt * 1000) / 3600 / mah * 100)
      // bus voltage: SoC curve minus resistive sag, floored so it never lies
      state.vbus = Math.max(0.5, volts * (0.15 + 0.85 * (state.soc / 100)) - busA * 0.04)
      for (let i = 0; i < n; i++) {
        const stall = simState && simState.stallNm ? simState.stallNm[i] : 0
        const load = simState && simState.loadNm ? simState.loadNm[i] : 0
        const ratio = stall > 0 ? Math.min(2, load / stall) : 0
        // I²R stand-in: heat scales with load²; a stalled servo cooks in ~6 s
        const heat = ratio * ratio * 9
        state.temps[i] = Math.min(120, state.temps[i] + (heat - (state.temps[i] - PWR_AMB) * 0.06) * dt)
        if (state.temps[i] > PWR_CUTOFF) state.cut[i] = true
        else if (state.temps[i] < PWR_RECOVER) state.cut[i] = false
      }
      return state
    },
    hud() {
      return {
        soc: state.soc,
        vbus: state.vbus,
        busA: state.busA,
        tempMax: state.temps.length ? Math.max(...state.temps) : PWR_AMB,
        dead: state.soc < PWR_DEAD,
        cuts: state.cut.filter(Boolean).length,
      }
    },
    /** Battery swap — full charge, cool servos. */
    reset() {
      state.soc = 100
      state.vbus = volts
      state.busA = 0
      state.temps.fill(PWR_AMB)
      state.cut.fill(false)
    },
  }
}
