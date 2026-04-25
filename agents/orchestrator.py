"""
Orchestrator: pull world via MCP, optionally call Anthropic (Claude), send plan to MCP, loop.
"""

from __future__ import annotations
import argparse
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, Optional, Sequence

import anyio
from mcp_system.mcp_server import mcp

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

LOG_PATH = Path(
    os.getenv(
        "ORCHESTRATOR_LOG",
        ROOT / "logs" / "orchestrator.log",
    )
).resolve()
LOG_PATH.parent.mkdir(parents=True, exist_ok=True)

logger = logging.getLogger("orchestrator")
if not logger.handlers:
    logger.setLevel(logging.DEBUG)
    fh = logging.FileHandler(LOG_PATH, encoding="utf-8")
    fh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
    logger.addHandler(fh)
    logger.propagate = False

ACTIVE_STATUSES = {"active", "moving", "scanning", "idle"}
DEFAULT_INTERVAL = float(os.getenv("ORCHESTRATOR_INTERVAL", "0.3"))
IDLE_INTERVAL = float(os.getenv("ORCHESTRATOR_IDLE_INTERVAL", "5.0"))
MIN_LLM_INTERVAL = float(os.getenv("ORCHESTRATOR_MIN_LLM_INTERVAL", "10.0"))  # throttle LLM calls


# 1) Pull world state using MCP tool
async def _call_mcp(tool: str, args: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Invoke an MCP tool and return JSON-decoded payload."""
    resp = await mcp.call_tool(tool, args or {})
    if isinstance(resp, dict):
        return resp
    if isinstance(resp, Sequence):
        for block in resp:
            text = getattr(block, "text", None)
            if text:
                try:
                    return json.loads(text)
                except json.JSONDecodeError:
                    continue
    raise RuntimeError(f"MCP tool '{tool}' returned no JSON content")


async def _fetch_world_state():
    """Async wrapper used by pull_world and tests."""
    return await _call_mcp("get_world_state")


def pull_world() -> Dict[str, Any]:
    """Fetch latest world snapshot via MCP."""
    world = anyio.run(_fetch_world_state)
    logger.debug("World pulled: hazards=%s survivors=%s drones=%s",
                 len((world.get("sectors") or {})), len(world.get("discovered_survivors") or []), len(world.get("drones") or {}))
    return world


# 2) LLM invoker (Anthropic) with prompt built inline
def _anthropic_client():
    """Create Anthropic client if API key is present; else None."""
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        logger.info("ANTHROPIC_API_KEY not set — LLM disabled")
        return None
    try:
        import anthropic
        client = anthropic.Anthropic(api_key=api_key, base_url="https://api.ilmu.ai/anthropic")
        model = os.getenv("ANTHROPIC_MODEL", "ilmu-glm-5.1")
        logger.info("Anthropic client created (model=%s)", model)
        return client
    except Exception as exc:
        logger.warning("Anthropic client unavailable: %s", exc)
        return None


def build_prompt(world: Dict[str, Any]) -> str:
    drones = world.get("drones", {})
    sectors = world.get("sectors", {})
    coverage = world.get("coverage_pct", 0)
    found = world.get("found_survivors", 0)
    total = world.get("total_survivors", 0)
    wind = (world.get("wind") or {}).get("description", "")
    hazard_count = len([s for s in sectors.values() if s.get("hazard") or s.get("true_hazard")])
    hazard_lines = [
        f"- {sid}: hazard={s.get('hazard') or s.get('true_hazard')} scanned={s.get('scanned')} discovered={s.get('discovered')}"
        for sid, s in sectors.items()
        if s.get("hazard") or s.get("true_hazard")
    ]
    fleet_lines = [
        f"- {did}: {d.get('battery')}% {d.get('status')} target={d.get('target_sector')}"
        for did, d in drones.items()
    ]
    return f"""You are coordinating a DRONE RESCUE SIMULATION. Respond with ONLY valid JSON (no prose, no code fences) with keys: mode, strategy, priorities (array), constraints (object), notes (optional array).
State: coverage {coverage}%, survivors {found}/{total}, hazards {hazard_count}, wind '{wind}', mission {world.get('mission_status')}.
Hazards:
{os.linesep.join(hazard_lines) or '- none'}
Fleet:
{os.linesep.join(fleet_lines) or '- none'}
Guidance:
- Keep priorities short (max 8 items). Do NOT list the whole grid.
- Allowed priority tokens: hazard:<fire|smoke|unknown>, sector:<SID>, area:<SID>, mode:<rescue|coverage>.
- Prefer top hazards or key sectors; no per-drone micromanagement."""


def invoke_llm(world: Dict[str, Any], client, prompt: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Call Anthropic with the built prompt; returns raw JSON dict or None."""
    if not client:
        logger.info("invoke_llm: no client, skipping")
        return None
    prompt = prompt or build_prompt(world)
    try:
        model = os.getenv("ANTHROPIC_MODEL", "ilmu-glm-5.1")
        logger.info("invoke_llm: calling model=%s", model)
        resp = client.messages.create(
            model=model,
            max_tokens=4096,
            messages=[{"role": "user", "content": prompt}],
        )
        content = (resp.content[0].text or "").strip()
        logger.info("Anthropic raw response (%d chars): %s", len(content), content[:500])
        if content.startswith("```"):
            content = content.strip("`")
            if content.startswith("json"):
                content = content[4:]
            content = content.strip()
            if content.endswith("```"):
                content = content[:-3].strip()
        return json.loads(content)
    except json.JSONDecodeError as exc:
        logger.warning("Anthropic response not valid JSON: %s | raw: %s", exc, content[:200] if 'content' in dir() else 'N/A')
        return None
    except Exception as exc:
        logger.warning("Anthropic call failed: %s", exc)
        return None


# 3) LLM result parser
def parse_llm_result(plan_raw: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Normalize LLM JSON into the plan shape we expect."""
    if not isinstance(plan_raw, dict):
        return None
    return {
        "mode": plan_raw.get("mode") or plan_raw.get("phase") or "llm_direct",
        "strategy": plan_raw.get("strategy") or plan_raw.get("summary") or "LLM strategy",
        "priorities": plan_raw.get("priorities") or plan_raw.get("actions") or [],
        "constraints": plan_raw.get("constraints") or {},
        **({"notes": plan_raw.get("notes")} if plan_raw.get("notes") else {}),
    }


# 4) Send LLM result to swarm intelligence component
def push_plan(plan: Dict[str, Any]):
    """Send plan to MCP set_plan tool."""
    try:
        anyio.run(lambda: mcp.call_tool("set_plan", {"plan": plan}))
        logger.info("Plan pushed to MCP")
    except Exception as exc:
        logger.warning("Failed to push plan: %s", exc)


def _waiting_drones(world: Dict[str, Any]) -> list[str]:
    """Return drone ids that are free to receive new assignments."""
    drones = world.get("drones") or {}
    waiting: list[str] = []
    for did, d in drones.items():
        status = (d or {}).get("status")
        target = (d or {}).get("target_sector")
        if target and target != "__RECALL__":
            continue  # already has a destination
        if status in {"scanning", "recharging", "offline", "dead"}:
            continue
        if target == "__RECALL__" and status not in ("moving", "idle"):
            continue  # still returning to base
        waiting.append(did)
    return waiting


def push_assignments(world: Dict[str, Any]):
    """Trigger swarm assignment via MCP assign_targets."""
    try:
        waiting = _waiting_drones(world)
        drones = world.get("drones") or {}
        logger.debug(
            "assign_targets waiting=%s details=%s",
            waiting,
            {did: {"status": d.get("status"), "target": d.get("target_sector")} for did, d in drones.items()},
        )
        res = anyio.run(lambda: mcp.call_tool("assign_targets", {"waiting": waiting}))
        logger.info("assign_targets invoked waiting=%s result=%s", waiting, res)
    except Exception as exc:
        logger.warning("assign_targets failed: %s", exc)


# crucial change detection
def detect_crucial_change(world: Dict[str, Any], prev: Dict[str, Any]):
    """
    Compare world snapshot to previous snapshot and decide if LLM should be called.
    Returns (change_flag, new_snapshot, inactive_drop_flag).
    """
    sectors = world.get("sectors") or {}
    hazard_ids = {sid for sid, s in sectors.items() if s.get("hazard") or s.get("true_hazard")}
    unscanned_ids = {sid for sid, s in sectors.items() if (s.get("hazard") or s.get("true_hazard")) and not s.get("scanned")}
    survivors = {tuple(s) if isinstance(s, (list, tuple)) else s for s in (world.get("discovered_survivors") or [])}
    drones = world.get("drones") or {}
    activity = {did: (d.get("status") in ACTIVE_STATUSES) for did, d in drones.items()}
    inactive_drop = any(prev["activity"].get(did, True) and not activity.get(did, False) for did in activity) if prev["activity"] is not None else True
    change = (
        prev["hazards"] is None
        or hazard_ids != prev["hazards"]
        or unscanned_ids != prev["unscanned"]
        or survivors != prev["survivors"]
        or inactive_drop
    )

    snapshot = {
        "hazards": hazard_ids,
        "unscanned": unscanned_ids,
        "survivors": survivors,
        "activity": activity,
    }
    return change, snapshot, inactive_drop


# 5) Orchestrator loop
def orchestrate(loop: bool = True, interval: float = DEFAULT_INTERVAL, max_steps: int | None = None) -> Dict[str, Any]:
    """Main loop: pull world, detect change, invoke LLM, push plan, sleep."""
    client = _anthropic_client()
    wait_for_active = os.getenv("ORCHESTRATOR_WAIT_FOR_ACTIVE", "true").lower() not in ("0", "false", "no")
    # track last time we successfully invoked the LLM to enforce MIN_LLM_INTERVAL
    last_llm_ts = 0.0

    last_plan: Dict[str, Any] = {
        "mode": "idle",
        "strategy": "Waiting for mission start",
        "priorities": [],
        "constraints": {},
        "llm_used": False,
        "llm_reason": "initial_default",
    }
    last_plan_sent = None
    snapshot_prev = {"hazards": None, "unscanned": None, "survivors": None, "activity": None}
    failure_streak = 0
    steps = 0
    latest = None

    while True:
        try:
            world = pull_world()
            failure_streak = 0
        except Exception as exc:
            failure_streak += 1
            logger.error("World fetch failed (streak=%s): %s", failure_streak, exc)
            if failure_streak >= 3:
                raise
            time.sleep(interval)
            continue

        status = world.get("mission_status")
        if world.get("paused"):
            plan = {**last_plan, "mode": "paused", "strategy": "Simulation paused", "llm_used": False, "llm_reason": "mission_paused"}
            latest = {"world": world, "plan": plan}
            if plan != last_plan_sent:
                push_plan(plan)
                last_plan_sent = dict(plan)
            if not loop:
                break
            time.sleep(IDLE_INTERVAL)
            continue

        if wait_for_active and status != "active":
            plan = {**last_plan, "mode": "idle", "strategy": "Waiting for mission start", "llm_used": False, "llm_reason": "waiting for active mission"}
            latest = {"world": world, "plan": plan}
            if plan != last_plan_sent:
                push_plan(plan)
                last_plan_sent = dict(plan)
            if not loop:
                break
            time.sleep(IDLE_INTERVAL)
            continue

        crucial_change, snapshot_prev, inactive_drop = detect_crucial_change(world, snapshot_prev)

        llm_used = False
        llm_reason = None
        plan = None

        prompt_text = build_prompt(world)

        now = time.monotonic()
        llm_window_ok = (now - last_llm_ts) >= MIN_LLM_INTERVAL

        if crucial_change and llm_window_ok:
            logger.info("Crucial change detected — calling LLM (client=%s)", bool(client))
            parsed = parse_llm_result(invoke_llm(world, client, prompt_text))
            if parsed:
                plan = parsed
                plan["llm_model"] = os.getenv("ANTHROPIC_MODEL", "ilmu-glm-5.1")
                llm_used = True
                llm_reason = "llm_called"
                last_llm_ts = now
            else:
                llm_reason = "llm_unavailable_or_invalid"
                logger.warning("LLM call returned no valid result (client=%s)", bool(client))
        elif crucial_change and not llm_window_ok:
            llm_reason = f"rate_limited_{MIN_LLM_INTERVAL}s"
            logger.debug("Crucial change but rate-limited (%.1fs since last call)", now - last_llm_ts)
        else:
            llm_reason = "no_crucial_change"

        if plan is None:
            plan = {
                "mode": "rescue_focus",
                "strategy": "Heuristic hazard-first plan",
                "priorities": ["hazards"],
                "constraints": {},
                "llm_used": False,
                "llm_reason": ("mission_status=waiting" if status != "active" else "ANTHROPIC_API_KEY missing") if not client else llm_reason,
            }
        plan["llm_used"] = llm_used
        plan["llm_reason"] = llm_reason if llm_used else plan.get("llm_reason", llm_reason)

        if plan != last_plan_sent:
            push_plan(plan)
            last_plan_sent = dict(plan)
        # Always try to assign targets using the freshest world+plan snapshot
        push_assignments(world)
        last_plan = plan
        latest = {"world": world, "plan": plan, "prompt": prompt_text}

        steps += 1
        if max_steps is not None and steps >= max_steps:
            break
        if not loop:
            break

        sleep_for = IDLE_INTERVAL if plan.get("mode") == "idle" else interval
        time.sleep(sleep_for)

    return latest or {}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run the orchestrator.")
    parser.add_argument("--once", action="store_true", help="Run a single step and exit.")
    parser.add_argument(
        "--interval",
        type=float,
        default=DEFAULT_INTERVAL,
        help="Seconds between steps (default: ORCHESTRATOR_INTERVAL or 1.0).",
    )
    parser.add_argument(
        "--max-steps",
        type=int,
        default=None,
        help="Optional cap on number of steps (useful for tests).",
    )
    args = parser.parse_args()

    loop_flag = not args.once
    logger.info("CLI start: loop=%s interval=%.2f max_steps=%s log=%s", loop_flag, args.interval, args.max_steps, LOG_PATH)
    result = orchestrate(loop=loop_flag, interval=args.interval, max_steps=args.max_steps)
    print(json.dumps(result.get("plan", {}), indent=2))
