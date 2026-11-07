# RigForge — demo script

Format: 1920×1080 · 25 fps · no audio track (captions carry meaning) · VO optional.
Master asset: `rigforge-submission.mp4` (78.8 s).

Read the left column as *what is on screen*, the right as *what the voice says*. The
captions already on the film are the short form; the VO lines are for when there is a
microphone or a live pitch.

---

## The 79-second cut (primary)

| t | on screen | voice-over |
|---|---|---|
| 0.0–4 | Title, then the studio empty | "You describe a machine in one sentence. RigForge builds it." |
| 4–10 | A sentence is typed: *a 5 inch drone that follows me on a bike* | "Not a template. That sentence becomes geometry, electronics, firmware and a bill of materials." |
| 10–19 | It decides the machine, sizes it, checks it; props start turning | "It picks the archetype, sizes the motors against the prop it chose, and runs its own checks — 80 of them are computed, not narrated." |
| 19–28 | Fly-through: close, through the frame, out to iso | "You can fly through it before you print anything." |
| 28–38 | Grab a part, drag it, release; mass and checks recompute | "Move a part and every number downstream recomputes: mass, torque, current, print time." |
| 38–46 | `⌁ how these numbers are made` — the audit ledger | "Every headline number opens into the arithmetic that made it. Here is the cost ledger — it balances to the cent." |
| 46–55 | Test bench, then export list (13 outputs) | "Field-test it, then export: STLs, a 3MF per plate, STEP for CAD, URDF and MJCF for ROS and MuJoCo, firmware, spec sheet, BOM." |
| **55–76** | **The refusal**: 0.8 kg arm is fine → drag to 2.4 kg → red, STALL tags, *"20.6 N·m needed · 8.1× past the servo · use NEMA17 + 5:1 or cut reach"* → drag back, it clears | **"And when it can't, it says so — with the number and the fix. Most tools let you buy the wrong servos. This one tells you before you do."** |
| 76–78.8 | End card: 13 build presets · 80 number claims · 8 motion claims · every number computed, never narrated | (silence) |

**The beat that wins it is 55–76.** Everything before establishes range; that shot
establishes trust. Do not cut it for time — cut the fly-through instead.

---

## 30-second cut (if the venue caps length)

| t | on screen | voice-over |
|---|---|---|
| 0–3 | Title + the typed sentence | "Describe a machine — get a buildable design." |
| 3–11 | Composition + checks + spinning props | "Geometry, motors sized against props, electronics, firmware, BOM." |
| 11–21 | The refusal beat | "Ask for 2.4 kg on an arm rated for 0.8 and it refuses: 20.6 newton-metres, eight times the servo. It names the fix." |
| 21–28 | Audit ledger balancing | "Every number opens into its own arithmetic." |
| 28–30 | End card | — |

---

## 15-second cut (social)

| t | on screen | caption |
|---|---|---|
| 0–5 | Sentence → machine appears | "one sentence" |
| 5–11 | Drag payload → red refusal | "it tells you what won't work" |
| 11–15 | End card | "RigForge · 13 machines · every number computed" |

---

## Live-pitch variant (if demoing the app, not the film)

1. Type: **"a mobile robot with wheels and an arm that carries 2 kg"** — it builds a
   full robot, not a desk gadget.
2. Press **REACH** and read the workspace chip: reachable / liftable / over-torque /
   out of reach — four different numbers for four different fixes.
3. Press **⌁ how these numbers are made**: the column adds up.
4. Drag **PAYLOAD** to 4 kg: red STALL tags, and the line that names the servo and the
   reduction.
5. **Export** → 13 outputs, 11 of them files.

Do not narrate a number that is not on screen. Every figure in the film is produced by
the build in the film; that is the whole claim.

---

## Assets that already exist

| file | length | use |
|---|---|---|
| `~/rigforge-submission.mp4` | 78.8 s | the submission cut |
| `~/rigforge-demo-v3.mp4` | 58.3 s | product tour only |
| `~/rigforge-payload.mp4` | 25.2 s | the refusal beat alone |
| `~/rigforge-audit.mp4` | 18.1 s | the audit ledger alone |
| `~/rigforge-explainer.mp4` | 78.0 s | nine-chapter explainer |
| `~/rigforge-shorts-v5.mp4` | 34 s | portrait / social |
