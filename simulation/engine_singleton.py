"""Shared SimulationEngine instance so MCP and REST API use the same state."""

from simulation.systems.simulation_engine import SimulationEngine

engine = SimulationEngine()

__all__ = ["engine"]
