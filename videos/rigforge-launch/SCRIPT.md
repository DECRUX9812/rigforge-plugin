# RigForge launch — script & beat sheet

No voiceover — the UI carries the words; lower-third captions carry the story.
Source: real screen capture of the preview build (`tests/tmp/record-demo.mjs`,
Playwright + SwiftShader, 1440×810@25). Cut: `assemble.sh` (ffmpeg).

## Beats (output time → caption)

| t | caption | what's on screen |
|---|---------|------------------|
| 0.6–4.2 | RIGFORGE — printed-machine design studio | title over the studio (default IoT node) |
| 0.8–11.6 | 01 / BUILD | palette "survey rover" → rover assembles; orbit |
| 12.2–19.6 | 02 / BENCH + DRIVE | TEST tab statics (CoM, support polygon, wall DFM) then W-drive on the traction rack |
| 20.2–39.6 | 03 / CERTIFY | AUTO runs SPRINT/TURN/CLIMB/LOAD/SHOVE/RETURN live (2.5×) → 6/6 scored |
| 40.2–52.6 | 04 / BREAK | STAIRS course — bumps, stalls at 80mm risers with 100mm wheels |
| 53.2–61.6 | 05 / FIX | ⚒ "80mm risers beat wheel bite" → APPLY FIX → rebuild at 150mm wheels |
| 62.2–71.6 | 06 / RANGE | gantry teleop — WASD portal/saddle + F/R quill, live X/Y/Z HUD (drag chain + ctrl box visible) |
| 72.2–81.6 | 07-08 / AUTHOR | custom machine preset → spec editor dialog (nodes/joints JSON IS the design) |
| 82.2–85.6 | 09 / EXPORT | Export ▾ → Build spec .md |
| 86.0–89.0 | outro card | Build · Drive · Break · Fix · Export — repo + @NousResearch |

## Why this cut

- The failure is REAL: 100mm wheels (r=50) vs 80mm porch risers — the sim
  bumps and stalls; the fix row prescribes ≥150mm wheels; APPLY FIX rebuilds.
- Every number is computed: cert 6/6, wall check ~2.6mm, 36-point support
  polygon, actuator sizing table — no mocks, no narration claims.
- 89.0s — under the 90s hackathon cap.

## Reproduce

```
node tests/tmp/record-demo.mjs          # writes webm to scratch dir
# point SRC in assemble.sh at the new webm, then:
bash videos/rigforge-launch/assemble.sh
```
