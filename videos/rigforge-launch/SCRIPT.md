# RigForge launch — script & beat sheet

No voiceover — the UI carries the words; lower-third captions carry the story.
Source: real screen capture of the preview build (`tests/tmp/record-demo.mjs`,
Playwright + SwiftShader, 1440×810@25). Cut: `assemble.sh` (ffmpeg).

## Beats (output time → caption)

| t | caption | what's on screen |
|---|---------|------------------|
| 0.6–4.2 | RIGFORGE — printed-machine design studio | title over the chooser |
| 0.8–10.6 | 01 / BUILD | palette "survey rover" → rover assembles; orbit |
| 11.4–21.4 | 02 / BENCH + DRIVE | TEST tab statics (CoM, support polygon, wall DFM) then W-drive on the traction rack |
| 22.4–38.2 | 03 / CERTIFY | AUTO runs SPRINT/TURN/CLIMB/LOAD/SHOVE/RETURN live → CERTIFICATION 6/6 report |
| 39.0–48.2 | 04 / BREAK | STAIRS course — bumps ×2, stalls at 80mm risers with 100mm wheels |
| 49.0–59.2 | 05 / FIX | ⚒ "80mm risers beat wheel bite" → APPLY FIX → rebuild at 150mm wheels |
| 60.0–69.2 | 06 / RANGE | gantry teleop — WASD portal/saddle + F/R quill, live X/Y/Z HUD |
| 70.0–78.2 | 07-08 / AUTHOR | custom machine preset → spec editor dialog (nodes/joints JSON IS the design) |
| 78.8–82.3 | 09 / EXPORT | Export ▾ → Build spec .md |
| 82.7–85.7 | outro card | Build · Drive · Break · Fix · Export — repo + @NousResearch |

## Why this cut

- The failure is REAL: 100mm wheels (r=50) vs 80mm porch risers — the sim
  bumps and stalls; the fix row prescribes ≥150mm wheels; APPLY FIX rebuilds.
- Every number is computed: cert 6/6, wall check ~2.6mm, 36-point support
  polygon, actuator sizing table — no mocks, no narration claims.
- 85.68s — under the 90s hackathon cap with margin.

## Reproduce

```
node tests/tmp/record-demo.mjs          # writes webm to scratch dir
# point SRC in assemble.sh at the new webm, then:
bash videos/rigforge-launch/assemble.sh
```
