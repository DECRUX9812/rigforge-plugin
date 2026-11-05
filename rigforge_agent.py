"""Rigforge agent half — queue a machine for the studio, read back what it built.

The studio (``desktop/plugin.js``) owns the engineering engine: geometry, torque
cascade, power budget, pin map, firmware, BOM. This half is deliberately thin —
it is the *handoff*, not a second engine:

    agent --rigforge_build--> queue.json --GET /api/plugins/rigforge/queue--> UI
    agent <--rigforge_state-- state.json <--POST /api/plugins/rigforge/state-- UI

State is two small JSON files under ``$HERMES_HOME/rigforge``. No model calls,
no network, no subprocess. Every write is atomic (tmp + ``os.replace``) so a
half-written queue can never wedge the poller.
"""

from __future__ import annotations

import json
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional

ARCHETYPES = ("humanoid", "robot", "arm", "rover", "quadruped", "gripper", "gadget")

DEFAULT_BRIEF: Dict[str, Any] = {
    "archetype": "arm",
    "mission": "5-DoF servo arm for pick and place on a workbench",
    "payloadKg": 1.0,
    "reachMm": 450,
    "dof": 5,
    "material": "petg",
    "mcu": "esp32s3",
    "battery": "pack3s",
    "wheelMm": 100,
}

MAX_QUEUE = 20
MAX_TEXT = 400


# ── store ────────────────────────────────────────────────────────────────────

def state_root() -> Path:
    """Plugin state under the ACTIVE profile's home, never a hardcoded path."""
    try:
        from hermes_constants import get_hermes_home  # type: ignore

        base = Path(get_hermes_home())
    except Exception:  # pragma: no cover - bare interpreter / import probe
        base = Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))
    root = base / "rigforge"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _path(name: str) -> Path:
    return state_root() / name


def _read(name: str, default: Any) -> Any:
    try:
        with _path(name).open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, type(default)) else default
    except (OSError, ValueError):
        return default


def _write(name: str, payload: Any) -> None:
    target = _path(name)
    tmp = target.with_suffix(target.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)
    os.replace(tmp, target)


def queue() -> List[Dict[str, Any]]:
    items = _read("queue.json", [])
    return [i for i in items if isinstance(i, dict)]


def peek(limit: int = 10) -> List[Dict[str, Any]]:
    return queue()[: max(1, min(limit, MAX_QUEUE))]


def pop(limit: int = 5) -> List[Dict[str, Any]]:
    """Hand the next ``limit`` requests to the studio and remove them."""
    items = queue()
    if not items:
        return []
    taken, rest = items[:limit], items[limit:]
    _write("queue.json", rest)
    return taken


def enqueue(brief: Mapping[str, Any], note: str = "", source: str = "agent") -> Dict[str, Any]:
    entry = {
        "id": uuid.uuid4().hex[:12],
        "at": int(time.time() * 1000),
        "source": str(source)[:32],
        "note": str(note)[:MAX_TEXT],
        "brief": normalise_brief(brief),
    }
    items = [entry] + queue()
    _write("queue.json", items[:MAX_QUEUE])
    return entry


def save_state(payload: Mapping[str, Any]) -> Dict[str, Any]:
    """The studio posts a summary after every build; keep it small and bounded."""
    checks = payload.get("checks") or []
    clean_checks = []
    if isinstance(checks, list):
        for c in checks[:12]:
            if isinstance(c, dict):
                clean_checks.append({
                    "level": str(c.get("level", ""))[:8],
                    "msg": str(c.get("msg", ""))[:MAX_TEXT],
                })
    state = {
        "at": int(time.time() * 1000),
        "title": str(payload.get("title", ""))[:120],
        "archetype": str(payload.get("archetype", ""))[:24],
        "brief": normalise_brief(payload.get("brief") or {}),
        "cost": _num(payload.get("cost")),
        "massG": _num(payload.get("massG")),
        "printHours": _num(payload.get("printHours")),
        "peakAmps": _num(payload.get("peakAmps")),
        "partCount": int(_num(payload.get("partCount"))),
        "checks": clean_checks,
    }
    # The parts list is what the price tool needs; a BOM is not a place to be
    # clever about size, so it is bounded but kept whole.
    parts_in = payload.get("parts") or []
    if isinstance(parts_in, list):
        state["parts"] = [
            {
                "key": str(p.get("key", ""))[:40],
                "name": str(p.get("name", ""))[:80],
                "sku": str(p.get("sku", ""))[:80],
                "qty": _num(p.get("qty")) or 1,
                "price": _num(p.get("price")),
                "shop": bool(p.get("shop")),
            }
            for p in parts_in[:60]
            if isinstance(p, dict)
        ]
    _write("state.json", state)
    return state


def load_state() -> Dict[str, Any]:
    return _read("state.json", {})


def _num(value: Any) -> float:
    try:
        return round(float(value), 3)
    except (TypeError, ValueError):
        return 0.0


# ── briefs ───────────────────────────────────────────────────────────────────

def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def detect_archetype(text: str) -> str:
    t = text.lower()
    if re.search(r"humanoid|biped|two.?leg|android", t):
        return "humanoid"
    if re.search(r"full robot|mobile manipulator|robot arm on a (rover|base|chassis)|whole robot", t):
        return "robot"
    if re.search(r"quadruped|four.?leg|walking|dog\b|trot", t):
        return "quadruped"
    if re.search(r"gripper|claw|\bjaw\b|end.?effector", t):
        return "gripper"
    if re.search(r"\barm\b|manipulator|pick.?(and|&).?place|do-?f|delta", t):
        return "arm"
    if re.search(r"rover|robot car|\bcar\b|tank|wheels?|mecanum|chassis", t):
        return "rover"
    return "gadget"


def parse_brief(text: str) -> Dict[str, Any]:
    """Mirror of the studio's JS parser: same keywords, same defaults, same clamps."""
    brief = dict(DEFAULT_BRIEF)
    text = (text or "").strip()
    brief["mission"] = text[:MAX_TEXT]
    brief["archetype"] = detect_archetype(text)

    kg = re.search(r"(\d+(?:[.,]\d+)?)\s*(?:kg|kilo)", text, re.I)
    if kg:
        brief["payloadKg"] = round(_clamp(float(kg.group(1).replace(",", ".")), 0.1, 15), 2)
    else:
        grams = re.search(r"(\d{2,4})\s*g(?:ram)?\b", text, re.I)
        if grams:
            brief["payloadKg"] = round(_clamp(int(grams.group(1)) / 1000, 0.1, 15), 2)

    wheel = re.search(r"(\d{2,3})\s*mm[^.,;]{0,14}?wheels?", text, re.I) or re.search(r"wheels?[^.,;]{0,14}?(\d{2,3})\s*mm", text, re.I)
    if wheel:
        brief["wheelMm"] = int(_clamp(int(wheel.group(1)), 60, 160))
    mm = re.search(r"(\d{2,4})\s*mm(?!\s*[^.,;]{0,10}wheels?)", text, re.I)
    cm = re.search(r"(\d{1,3})\s*cm", text, re.I)
    if mm and not (brief.get("wheelMm") and int(mm.group(1)) == brief["wheelMm"]):
        brief["reachMm"] = int(_clamp(int(mm.group(1)), 120, 1200))
    elif cm:
        brief["reachMm"] = int(_clamp(int(cm.group(1)) * 10, 120, 1200))

    dof = re.search(r"([3-6])\s*(?:dof|do f|degrees? of freedom|axes|axis)", text, re.I)
    if dof:
        brief["dof"] = int(dof.group(1))

    if re.search(r"petg", text, re.I):
        brief["material"] = "petg"
    if re.search(r"\bpla\b", text, re.I):
        brief["material"] = "pla"
    if re.search(r"pico|rp2|raspberry", text, re.I):
        brief["mcu"] = "pico"
    if re.search(r"\bc6\b|thread|zigbee", text, re.I):
        brief["mcu"] = "esp32c6"
    if re.search(r"lipo", text, re.I):
        brief["battery"] = "lipo3s" if re.search(r"3s", text, re.I) else "lipo2s"
    if re.search(r"usb|tethered|desk", text, re.I):
        brief["battery"] = "pd5v"
    if brief["archetype"] == "gadget":
        brief["reachMm"] = 0
    if brief["archetype"] == "humanoid" and not mm:
        brief["reachMm"] = 550
    if brief["archetype"] == "robot" and not wheel:
        brief["wheelMm"] = 130
    return brief


def normalise_brief(raw: Mapping[str, Any]) -> Dict[str, Any]:
    """One validator for both directions (agent args and the studio's POST)."""
    brief = dict(DEFAULT_BRIEF)
    for key in ("mission",):
        if raw.get(key):
            brief[key] = str(raw[key])[:MAX_TEXT]
    archetype = str(raw.get("archetype") or brief["archetype"]).lower()
    brief["archetype"] = archetype if archetype in ARCHETYPES else "arm"
    for key, lo, hi in (("payloadKg", 0.1, 15), ("reachMm", 0, 1200), ("wheelMm", 60, 130), ("dof", 3, 6)):
        if raw.get(key) is not None:
            try:
                brief[key] = round(_clamp(float(raw[key]), lo, hi), 2) if key != "dof" else int(_clamp(float(raw[key]), lo, hi))
            except (TypeError, ValueError):
                pass
    for key, allowed in (("material", ("pla", "petg")), ("mcu", ("esp32s3", "esp32c6", "pico")),
                         ("battery", ("pack2s", "pack3s", "lipo2s", "lipo3s", "pd5v"))):
        value = str(raw.get(key) or brief[key])
        brief[key] = value if value in allowed else brief[key]
    return brief


def directive(brief: Mapping[str, Any]) -> str:
    """The chat-side twin of a queued build: one line the studio's directive renders."""
    return "::rigforge{brief=" + json.dumps(dict(brief), ensure_ascii=False, separators=(",", ":")) + "}"


# ── tools ────────────────────────────────────────────────────────────────────

def rigforge_build(args: Mapping[str, Any] | None = None, **kw: Any) -> str:
    args = args or {}
    raw = args.get("brief")
    if isinstance(raw, Mapping):
        brief = normalise_brief(raw)
    elif isinstance(raw, str):
        text = raw.strip()
        if text.startswith("{"):
            try:
                brief = normalise_brief(json.loads(text))
            except ValueError:
                brief = parse_brief(text)
        else:
            brief = parse_brief(text)
    else:
        return json.dumps({"ok": False, "error": "brief is required (a sentence or a params object)"})

    overrides = {
        "archetype": args.get("archetype"), "payload_kg": args.get("payload_kg"),
        "reach_mm": args.get("reach_mm"), "dof": args.get("dof"),
        "material": args.get("material"), "mcu": args.get("mcu"),
        "battery": args.get("battery"), "wheel_mm": args.get("wheel_mm"),
    }
    mapped = {
        "archetype": overrides["archetype"], "payloadKg": overrides["payload_kg"],
        "reachMm": overrides["reach_mm"], "dof": overrides["dof"],
        "material": overrides["material"], "mcu": overrides["mcu"],
        "battery": overrides["battery"], "wheelMm": overrides["wheel_mm"],
    }
    brief = normalise_brief({**brief, **{k: v for k, v in mapped.items() if v is not None}})

    entry = enqueue(brief, note=str(args.get("note") or ""))
    return json.dumps({
        "ok": True,
        "request_id": entry["id"],
        "brief": brief,
        "queued": len(queue()),
        "directive": directive(brief),
        "next": (
            "Queued for the Rigforge studio — it picks this up within ~4s while open "
            "(sidebar ▸ Rigforge). To also show the card inline in this chat, put the "
            "'directive' value on its own line in your reply."
        ),
    })


def rigforge_state(args: Mapping[str, Any] | None = None, **kw: Any) -> str:
    state = load_state()
    pending = queue()
    if not state:
        return json.dumps({
            "ok": True,
            "studio": "no build posted yet",
            "queued": len(pending),
            "hint": "Open the Rigforge page once — it posts its current build here.",
        })
    return json.dumps({
        "ok": True,
        "studio": "live",
        "age_seconds": max(0, int(time.time() * 1000 - int(state.get("at") or 0)) // 1000),
        "build": state,
        "queued": len(pending),
    })


def rigforge_prices(args: Mapping[str, Any] | None = None, **kw: Any) -> str:
    """Live prices for the current build, from the LCSC parts index.

    Reads the BOM the studio last posted (state.json), asks a real supplier what
    each part costs right now, and answers with a table plus a directive the
    studio can render. Chips get a real number; hobby modules that LCSC does not
    stock keep the catalogue estimate and are marked as such — the tool never
    invents a price to fill a row.
    """
    try:
        import prices as price_mod  # type: ignore
    except Exception:
        return json.dumps({"ok": False, "error": "price module unavailable"})

    state = load_state()
    parts = state.get("parts") or []
    if not parts:
        return json.dumps({
            "ok": False,
            "error": "no BOM posted yet",
            "hint": "Open the Rigforge studio once — it posts the current build (with its parts) here.",
        })

    report = price_mod.price_design(parts)
    rows = report.get("rows") or {}
    lines = []
    for sku, row in rows.items():
        if row.get("kind") == "live":
            lines.append(f"{sku} — ${row['price']:.2f} ×{row['qty']:g} = ${row['line']:.2f} ({row['sku']}, stock {row.get('stock')})")
        else:
            lines.append(f"{sku} — estimate ${row.get('line', 0):.2f} (not stocked by LCSC)")
    summary = (
        f"{report['liveLines']}/{report['lines']} lines priced live: "
        f"${report['liveTotal']:.2f} live + ${report['estimateTotal']:.2f} estimated"
    )
    directive = "::rigforge{prices=" + json.dumps({
        "rows": rows,
        "liveTotal": report["liveTotal"],
        "estimateTotal": report["estimateTotal"],
        "liveLines": report["liveLines"],
        "lines": report["lines"],
        "fetched": report["fetched"],
    }, ensure_ascii=False).replace("}", "}") + "}"

    # keep the last price pass with the build, so the studio can show it
    try:
        state["prices"] = report
        _write("state.json", state)
    except Exception:
        pass

    return json.dumps({
        "ok": True,
        "summary": summary,
        "rows": report["rows"],
        "directive": directive,
        "note": "Prices are USD list prices from the LCSC parts index, cached 12h.",
    }, ensure_ascii=False)



_SCHEMA_PRICES = {
    "name": "rigforge_prices",
    "description": (
        "Get live prices for the robot/BOM currently loaded in the Rigforge studio. "
        "Asks the LCSC parts index for real unit prices (chips and modules it stocks), "
        "returns a table and a ::rigforge{prices=...} directive the studio can render. "
        "HONESTY: parts LCSC does not stock keep the catalogue estimate and are labelled "
        "as estimates — never present an estimate as a live price."
    ),
    "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
}

_SCHEMA_BUILD = {
    "name": "rigforge_build",
    "description": (
        "Queue a machine for the Rigforge build studio: robots and 3D-printed devices. "
        "Returns the parsed brief plus a ::rigforge directive. The studio computes geometry, "
        "joint torque sizing, power budget, pin map, firmware, BOM and print time from it."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "brief": {
                "type": ["string", "object"],
                "description": "One sentence ('4WD rover, 2kg payload, 100mm wheels') or a params object.",
            },
            "archetype": {"type": "string", "enum": list(ARCHETYPES), "description": "Override the archetype ('robot' is a full mobile manipulator)."},
            "payload_kg": {"type": "number", "description": "Payload mass in kg."},
            "reach_mm": {"type": "number", "description": "Reach / leg span / jaw opening in mm."},
            "dof": {"type": "integer", "description": "Joint count for an arm (3-6)."},
            "wheel_mm": {"type": "number", "description": "Wheel diameter for a rover (60-130)."},
            "material": {"type": "string", "enum": ["pla", "petg"]},
            "mcu": {"type": "string", "enum": ["esp32s3", "esp32c6", "pico"]},
            "battery": {"type": "string", "enum": ["pack2s", "pack3s", "lipo2s", "lipo3s", "pd5v"]},
            "note": {"type": "string", "description": "Why this build — shown in the studio."},
        },
        "required": ["brief"],
    },
}

_SCHEMA_STATE = {
    "name": "rigforge_state",
    "description": "Read back the build the Rigforge studio computed last: cost, mass, print time, strain warnings.",
    "parameters": {"type": "object", "properties": {}},
}

SCHEMAS = {
    "rigforge_build": _SCHEMA_BUILD,
    "rigforge_state": _SCHEMA_STATE,
    "rigforge_prices": _SCHEMA_PRICES,
}
HANDLERS = {
    "rigforge_build": rigforge_build,
    "rigforge_state": rigforge_state,
    "rigforge_prices": rigforge_prices,
}
