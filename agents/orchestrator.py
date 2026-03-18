"""
Orchestrator / LLM agent logic.

What should we achieve?
"""

def get_world_state():
    """
    Here we need to maximize our observability of the complete environment, by utilising multiple
    MCP tools to gather as much information as possible.
    """
    pass

def set_global_strategy():
    """
    Here we will set the highest level goal to be obeyed by the swarm intelligence systems. Note that here
    we only make a single decision, which is to set the global strategy. The swarm intelligence systems
    will be responsible for the execution of the global strategy.
    """
    pass

def build_high_level_prompt():
    """
    Build the prompt for coordinating the LLM.
    """
    prompt = f"""You are an autonomous rescue swarm coordinator responsible for guiding a fleet of drones in a disaster environment.

    Your role is NOT to micromanage individual drone movements, but to define high-level strategy, priorities, and constraints that guide decentralized swarm behavior.

    MISSION STATE (elapsed: {elapsed_seconds}s)
    Coverage: {sectors.get('coverage_pct',0)}% | Survivors found: {sectors.get('found_survivors',0)}/{sectors.get('total_survivors',0)} | Wind: {sectors.get('wind','')}
    Environment: discovered fire zones {len(env.get('discovered_fire_zones', []))}, smoke sectors {len(env.get('smoke_sectors', []))}, grid size {env.get('grid_size','?')}

    FLEET STATUS:
    {os.linesep.join(fleet_lines)}

    AVAILABLE SECTOR OPTIONS (aggregated overview):
    {os.linesep.join(rec_lines)}

    OBJECTIVE:
    Maximise survivor discovery while maintaining safe drone operation and efficient area coverage.

    GUIDELINES:
    1. Prioritise survivor detection over exploration when signals or hazards suggest human presence.
    2. Ensure drones maintain safe battery levels and can return to base.
    3. Avoid overcrowding drones in the same area unless necessary (e.g. high-risk zones).
    4. Balance exploration (uncovered sectors) and exploitation (known hazards or survivor signals).
    5. Consider environmental risks such as fire and smoke when assigning priorities.

    OUTPUT FORMAT — respond with valid JSON only, no markdown, no extra text:
    {{
    "strategy": "High-level plan describing how the swarm should behave (e.g. exploration vs rescue focus, hazard avoidance, sector prioritisation).",
    "priorities": [
        "List 3–5 key priorities guiding drone behaviour (e.g. 'prioritise sectors near smoke signals', 'limit 2 drones per fire zone', 'recall drones below 25% battery')"
    ],
    "constraints": {{
        "max_drones_per_sector": <number>,
        "battery_recall_threshold": <percentage>,
        "hazard_avoidance": "<low|medium|high>"
    }}
    }}
    """

def orchestrate():
    """
    Here we will orchestrate the entire simulation.
    """
    while True:
        world_summary = get_world_state()
    


