"""``hermes rigforge …`` — the same queue the agent tool writes, from a shell.

    hermes rigforge build "4WD rover, 2kg, 100mm wheels"
    hermes rigforge state
    hermes rigforge queue
    hermes rigforge clear
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

_PLUGIN_DIR = str(Path(__file__).resolve().parent)
if _PLUGIN_DIR not in sys.path:
    sys.path.insert(0, _PLUGIN_DIR)

from rigforge_agent import (  # noqa: E402
    directive,
    enqueue,
    load_state,
    parse_brief,
    peek,
    queue,
    state_root,
)


def register_cli(subparser: Any) -> None:
    p = subparser.add_parser("rigforge", help="Build studio for robots and printed machines")
    subs = p.add_subparsers(dest="rigforge_command")

    b = subs.add_parser("build", help="Queue a machine for the studio")
    b.add_argument("brief", nargs="+", help="One sentence describing the machine")
    b.add_argument("--archetype", choices=["arm", "rover", "quadruped", "gripper", "gadget"])
    b.add_argument("--note", default="", help="Why this build")

    subs.add_parser("state", help="What the studio computed last")
    subs.add_parser("queue", help="Pending build requests")
    subs.add_parser("clear", help="Drop pending build requests")


def run(args: Any) -> int:
    cmd = getattr(args, "rigforge_command", None)

    if cmd == "build":
        text = " ".join(getattr(args, "brief", []) or [])
        brief = parse_brief(text)
        if getattr(args, "archetype", None):
            brief["archetype"] = args.archetype
        entry = enqueue(brief, note=getattr(args, "note", "") or "", source="cli")
        print(f"queued {entry['id']} · {brief['archetype']} · {brief.get('mission', '')[:70]}")
        print(f"state dir: {state_root()}")
        print(directive(brief))
        return 0

    if cmd == "state":
        state = load_state()
        print(json.dumps(state or {"studio": "no build posted yet"}, indent=2))
        return 0

    if cmd == "queue":
        items = peek(20)
        if not items:
            print("queue empty")
            return 0
        for item in items:
            b = item.get("brief", {})
            print(f"{item['id']}  {b.get('archetype','?'):<10} {str(b.get('mission',''))[:60]}")
        return 0

    if cmd == "clear":
        Path(state_root() / "queue.json").write_text("[]", encoding="utf-8")
        print("queue cleared")
        return 0

    if queue():
        print(f"{len(queue())} pending — 'hermes rigforge queue' to list, 'state' to read the last build")
    else:
        print("nothing queued. Try: hermes rigforge build \"4WD rover, 2kg, 100mm wheels\"")
    return 0
