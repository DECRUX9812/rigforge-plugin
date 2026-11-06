# RigForge launch — script & beat sheet

No voiceover — the UI carries the words; lower-third captions carry the story.
Source: real screen capture of the preview build (`tests/tmp/record-demo.mjs`,
Playwright + SwiftShader, 1440×810@25). Cut: `assemble.sh` (ffmpeg).

## Beats (output time → caption)

| t | caption | what's on screen |
|---|---------|------------------|
| 0.6–4.2 | RIGFORGE — printed-machine design studio | title over the studio (default IoT node) |
| 0.8–14.6 | 01 / BUILD | palette "survey rover" → rover assembles; orbit |
| 15.2–23.1 | 02 / BENCH + DRIVE | TEST tab statics (CoM, support polygon, wall DFM) then W-drive on the traction rack |
| 23.7–39.3 | 03 / CERTIFY | AUTO runs SPRINT/TURN/CLIMB/LOAD/SHOVE/RETURN live (3×) → 6/6 scored |
| 39.9–48.8 | 04 / BREAK | STAIRS course — bumps, stalls at 80mm risers with 100mm wheels |
| 49.4–56.8 | 05 / FIX | ⚒ "80mm risers beat wheel bite" → APPLY FIX → rebuild at 150mm wheels |
| 57.4–67.8 | 06 / RANGE | gantry teleop — WASD portal/saddle + F/R quill, live X/Y/Z HUD (ctrl box + end-stops visible) |
| 68.4–81.3 | 07-08 / AUTHOR | custom machine preset → spec editor dialog (nodes/joints JSON IS the design) |
| 81.9–85.3 | 09 / EXPORT | Export ▾ → Build spec .md |
| 85.7–88.7 | outro card | Build · Drive · Break · Fix · Export — repo + @NousResearch |

## Why this cut

- The failure is REAL: 100mm wheels (r=50) vs 80mm porch risers — the sim
  bumps and stalls; the fix row prescribes ≥150mm wheels; APPLY FIX rebuilds.
- Every number is computed: cert 6/6, wall check ~2.6mm, 36-point support
  polygon, actuator sizing table — no mocks, no narration claims.
- 88.8s — under the 90s hackathon cap.

## Reproduce

```
node tests/tmp/record-demo.mjs          # writes webm to scratch dir
# point SRC in assemble.sh at the new webm, then:
bash videos/rigforge-launch/assemble.sh
```
