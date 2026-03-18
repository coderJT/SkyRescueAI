"""
Orchestrator / LLM agent class. Note that the biggest purpose of this class is not just a bare MCP tool,
but a bridge between our simulation environment (regardless of 2D/3D) and our key decision makers - LLM itself.
In other words, we should expose our simulation as controllable tools with maximum observability to ensure rescue
and implementation efficiency.

3 Main Tasks here:
1. Help LLMs to see the world/environment.
2. Help LLMs to reason about the world. 
3. Help LLMs to take actual actions.

LLM -> ***MCP server (Tools)*** -> Simulation
"""

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("Rescue Drone Server")

simulation_service = SimulationService();

@mcp.tool()
def get_all_drones():
    pass

@mcp.tool()
def get_drone_status(id):
    pass

@mcp.tool()
def move_drone_to(id, x, y, z):
    pass

@mcp.tool()
def discover_surroundings_of_drone(id):
    pass

@mcp.tool()
def thermal_scan_of_drone(id):
    pass

@mcp.tool()
def get_known_hazard_coordinates():
    pass

@mcp.tool()
def get_unknown_hazard_coordinates():
    pass



