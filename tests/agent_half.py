"""Agent-half proof: registration, store round-trip, and the HTTP routes.

Run with a throwaway HERMES_HOME so nothing touches the real profile::

    HERMES_HOME=$(mktemp -d) python3 tests/agent_half.py
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault("HERMES_HOME", tempfile.mkdtemp(prefix="rigforge-test-"))

failures: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  ok   {name}")
    else:
        failures.append(name)
        print(f"  FAIL {name}{' — ' + detail if detail else ''}")


# ── 1. the loader's own import path (hermes_plugins.<slug>, package-present) ──
print("load")
spec = importlib.util.spec_from_file_location(
    "hermes_plugins.rigforge", ROOT / "__init__.py", submodule_search_locations=[str(ROOT)]
)
mod = importlib.util.module_from_spec(spec)
mod.__package__, mod.__path__ = "hermes_plugins.rigforge", [str(ROOT)]
sys.modules["hermes_plugins.rigforge"] = mod
spec.loader.exec_module(mod)  # the ImportError you would otherwise never see

tools: list[dict] = []
cli: list[dict] = []


class FakeCtx:
    def register_tool(self, name=None, toolset=None, schema=None, handler=None, **kw):
        tools.append({"name": name, "toolset": toolset, "schema": schema, "handler": handler})

    def register_cli_command(self, **kw):
        cli.append(kw)


mod.register(FakeCtx())
check("tools registered", [t["name"] for t in tools] == ["rigforge_build", "rigforge_state", "rigforge_prices"], str([t["name"] for t in tools]))
check("toolset is rigforge", all(t["toolset"] == "rigforge" for t in tools))
check("cli verb registered", any(c.get("name") == "rigforge" for c in cli))

build = [t for t in tools if t["name"] == "rigforge_build"][0]["handler"]
state = [t for t in tools if t["name"] == "rigforge_state"][0]["handler"]

# ── 2. handler contract: one positional dict (how the registry calls it) ─────
print("\ntools")
res = json.loads(build({"brief": "4WD rover with a camera mast, 3kg payload, 100mm wheels"}))
check("build ok", res.get("ok") is True, json.dumps(res)[:120])
check("archetype parsed", res["brief"]["archetype"] == "rover", res["brief"]["archetype"])
check("payload parsed", res["brief"]["payloadKg"] == 3, str(res["brief"]["payloadKg"]))
check("wheel parsed", res["brief"]["wheelMm"] == 100, str(res["brief"]["wheelMm"]))
check("directive emitted", res["directive"].startswith("::rigforge{brief={"))
check("request id", len(res.get("request_id", "")) == 12)

obj = json.loads(build({"brief": {"archetype": "quadruped", "mission": "trot bot"}, "payload_kg": 1.5}))
check("object brief accepted", obj["brief"]["archetype"] == "quadruped" and obj["brief"]["payloadKg"] == 1.5)

bad = json.loads(build({"brief": {"archetype": "spaceship", "payloadKg": 999}}))
check("invalid archetype recorded", bad["brief"]["archetype"] == "arm" and any("archetype" in a for a in bad["brief"].get("_adjusted", [])), str(bad["brief"].get("_adjusted")))
check("payload reaches the studio unclamped", json.loads(build({"brief": {"archetype": "rover", "payloadKg": 50}}))["brief"]["payloadKg"] == 50, "50kg must reach the studio so its own check fires")
check("absurd payload clamped and recorded", bad["brief"]["payloadKg"] == 500 and any("payloadKg" in a for a in bad["brief"].get("_adjusted", [])), str(bad["brief"]["payloadKg"]))
check("missing brief errors", json.loads(build({})).get("ok") is False)
# a sentence must not be quietly reduced to a smaller machine either
_sentence = json.loads(build({"brief": "a rover that carries 50 kg of soil"}))["brief"]
check("sentence payload survives", _sentence["payloadKg"] == 50, str(_sentence["payloadKg"]))

st = json.loads(state({}))
queued = st.get("queued")
check("state reports queued", isinstance(queued, int) and queued >= 3, str(st))

# ── 3. the HTTP routes the page polls and posts ────────────────────────────
# fastapi ships with the Hermes runtime, not this repo — skip the route
# section on a bare interpreter rather than failing the agent contract.
print("\nroutes")
try:
    sys.path.insert(0, str(ROOT / "dashboard"))
    import plugin_api  # noqa: E402
    from fastapi import FastAPI  # noqa: E402
    from fastapi.testclient import TestClient  # noqa: E402
except ImportError:
    plugin_api = None

if plugin_api is not None:
    app = FastAPI()
    app.include_router(plugin_api.router, prefix="/api/plugins/rigforge")
    client = TestClient(app)

    h = client.get("/api/plugins/rigforge/health").json()
    check("health ok", h.get("ok") is True and h.get("queued") == queued, json.dumps(h))

    peeked = client.get("/api/plugins/rigforge/queue", params={"peek": 1, "limit": 5}).json()
    check("peek does not drain", len(peeked["requests"]) == min(5, queued) and peeked["remaining"] == queued, json.dumps(peeked)[:120])

    drained = client.get("/api/plugins/rigforge/queue", params={"limit": 5}).json()
    check("drain returns all", len(drained["requests"]) == queued, json.dumps(drained)[:120])
    check("drain empties queue", drained["remaining"] == 0 and json.loads(state({}))["queued"] == 0)

    posted = client.post("/api/plugins/rigforge/queue", json={"brief": "desk clock with a bme280", "note": "from ui"}).json()
    check("post /queue enqueues", posted["ok"] and posted["request"]["brief"]["archetype"] == "gadget", json.dumps(posted)[:120])

    summary = {
        "title": "5-DoF arm · 450mm reach", "archetype": "arm",
        "brief": {"archetype": "arm", "payloadKg": 1, "reachMm": 450},
        "cost": 204.53, "massG": 1281, "printHours": 24.4, "peakAmps": 13.99,
        "partCount": 18,
        "checks": [{"level": "warn", "msg": "Stall/peak 14.0A exceeds the pack's 8A burst"},
                   {"level": "ok", "msg": "Sizing checks pass"}],
    }
    saved = client.post("/api/plugins/rigforge/state", json=summary).json()
    check("state saved", saved["ok"] and saved["state"]["cost"] == 204.53, json.dumps(saved)[:150])
    check("state bounded", len(saved["state"]["checks"]) == 2 and saved["state"]["title"].startswith("5-DoF"))

    back = json.loads(state({}))
    check("tool reads the studio state", back["build"]["cost"] == 204.53 and back["queued"] == 1, json.dumps(back)[:150])

    huge = client.post("/api/plugins/rigforge/state", json={"title": "x" * 5000, "checks": [{"msg": "y" * 9999}] * 40}).json()
    check("oversized payload truncated", len(huge["state"]["title"]) <= 120 and len(huge["state"]["checks"]) <= 12)

print("\n" + ("ALL PASS" if not failures else f"{len(failures)} FAILURES: {failures}"))
sys.exit(1 if failures else 0)
