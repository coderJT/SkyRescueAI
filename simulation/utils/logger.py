"""
Unified logging helper for engine + per-drone logs and UI mission log.
"""

from __future__ import annotations
import logging
from pathlib import Path
from typing import List, Optional, Dict

_LOG_DIR = Path(__file__).resolve().parent.parent.parent / "logs"
_LOG_DIR.mkdir(parents=True, exist_ok=True)

_lock = None  # simple guard to avoid re-entrancy if needed

_engine_logger: Optional[logging.Logger] = None
_drone_loggers: Dict[str, logging.Logger] = {}


def _init_engine_logger():
    global _engine_logger
    if _engine_logger:
        return _engine_logger
    logger = logging.getLogger("engine")
    if not logger.handlers:
        fh = logging.FileHandler(_LOG_DIR / "engine.log", encoding="utf-8")
        fh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
        logger.setLevel(logging.INFO)
        logger.addHandler(fh)
        logger.propagate = False
    _engine_logger = logger
    return logger


def _drone_logger(drone_id: str) -> logging.Logger:
    if drone_id in _drone_loggers:
        return _drone_loggers[drone_id]
    logger = logging.getLogger(f"engine.drone.{drone_id}")
    if not logger.handlers:
        path = _LOG_DIR / f"drone_{drone_id}.log"
        fh = logging.FileHandler(path, encoding="utf-8")
        fh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
        logger.setLevel(logging.INFO)
        logger.addHandler(fh)
        logger.propagate = False
    _drone_loggers[drone_id] = logger
    return logger


def log_event(message: str, *, level: str = "info", drone_id: str | None = None, mission_log: Optional[List[str]] = None):
    """
    Write a message to engine log, optional per-drone log, and append to mission_log for UI.
    """
    logger = _init_engine_logger()
    log_fn = getattr(logger, level, logger.info)
    log_fn(message)

    if drone_id:
        dlog = _drone_logger(drone_id)
        d_fn = getattr(dlog, level, dlog.info)
        d_fn(message)

    if mission_log is not None:
        mission_log.append(message)


def clear_drone_logs():
    """Utility for test/reset: closes and removes per-drone log files."""
    for lg in list(_drone_loggers.values()):
        for h in list(lg.handlers):
            try:
                h.close()
                lg.removeHandler(h)
            except Exception:
                pass
    _drone_loggers.clear()
    for p in _LOG_DIR.glob("drone_*.log"):
        try:
            p.unlink()
        except Exception:
            pass

