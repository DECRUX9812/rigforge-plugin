"""Hermes plugin: Rigforge — a build studio for robots and printed machines.

Two halves, one package:

* ``rigforge_agent.py`` — the ``rigforge_build`` / ``rigforge_state`` tools the
  agent calls (queue a machine, read back what the studio computed).
* ``desktop/plugin.js`` — the studio page, copied into ``desktop-plugins/`` by
  the app's own reconciler.

Import-safe and side-effect-free at import and inside ``register()``: the state
directory resolves per call, never here (one process serves several profiles,
and the capability probe imports this module in a bare interpreter).
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

_PLUGIN_DIR = str(Path(__file__).resolve().parent)
if _PLUGIN_DIR not in sys.path:
    sys.path.insert(0, _PLUGIN_DIR)

try:  # loaded as a package by the plugin loader / capability probe
    from .rigforge_agent import HANDLERS, SCHEMAS  # type: ignore
    from .rigforge_cli import register_cli  # type: ignore
except ImportError:  # loaded as a bare module (sys.path root only)
    from rigforge_agent import HANDLERS, SCHEMAS  # type: ignore
    from rigforge_cli import register_cli  # type: ignore

__all__ = ["register"]


def register(ctx: Any) -> None:
    """Wire the agent half: two tools and a CLI verb."""
    for name, handler in HANDLERS.items():
        ctx.register_tool(name=name, toolset="rigforge", schema=SCHEMAS[name], handler=handler)

    try:
        ctx.register_cli_command(
            name="rigforge",
            help="Build studio for robots and printed machines",
            setup_fn=register_cli,
            handler_fn=_cli_handler,
            description="Queue a machine for the Rigforge studio, or read back the last build.",
        )
    except Exception:  # pragma: no cover - older hosts without the CLI door
        pass


def _cli_handler(args: Any) -> int:
    from rigforge_cli import run

    return run(args)
