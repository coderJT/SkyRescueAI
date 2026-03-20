// API that calls to the server.py to perform engine-related functions

const DEFAULT_API_BASE = 'http://localhost:8000';

export async function apiFetch(path, options = {}) {
  const base = window.API_BASE || localStorage.getItem('API_BASE') || DEFAULT_API_BASE;
  const url = `${base}${path}`;
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const text = await res.text();
  let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { }
    return { ok: res.ok, status: res.status, json, text };
}

export const apiClient = {
  connected: false,
  async connect() {
    try {
      const ping = await apiFetch('/settings');
      if (ping.ok) { this.connected = true; return true; }
    } catch (e) {
      // propagate below
    }
    this.connected = false;
    throw new Error('MCP/API bridge unreachable; start API server.');
  },
    async callTool(name, args = {}) {
        // Map tool-like calls directly to FastAPI endpoints (no MCP server hop)
        const tool = name || '';
        if (!this.connected) {
            throw new Error('API bridge not connected');
        }

        try {
            switch (tool) {
                case 'start_mission': {
                    const payload = { survivor_count: args.survivor_count, active_drones: args.active_drones };
                    const resp = await apiFetch('/commands/start', { method: 'POST', body: JSON.stringify(payload) });
                    return { status: resp.ok ? 'ok' : 'error', content: [{ text: JSON.stringify(resp.json || {}) }] };
                }
                case 'get_world_state': {
                    const resp = await apiFetch('/state');
                    return { status: resp.ok ? 'ok' : 'error', content: [{ text: JSON.stringify(resp.json || {}) }] };
                }
                case 'thermal_scan': {
                    const payload = { drone_id: args.id || args.drone_id, sector_id: args.sector_id || args.sector };
                    const resp = await apiFetch('/commands/thermal_scan', { method: 'POST', body: JSON.stringify(payload) });
                    return { status: resp.ok ? 'ok' : 'error', content: [{ text: JSON.stringify(resp.json || {}) }] };
                }
                case 'get_all_drones': {
                    const resp = await apiFetch('/drones');
                    return { status: resp.ok ? 'ok' : 'error', content: [{ text: JSON.stringify(resp.json || {}) }] };
                }
                case 'get_drone_status': {
                    const resp = await apiFetch('/drones');
                    const one = resp.json && args.id ? { [args.id]: resp.json[args.id] } : resp.json;
                    return { status: resp.ok ? 'ok' : 'error', content: [{ text: JSON.stringify(one || {}) }] };
                }
                case 'toggle_pause': {
                    const resp = await apiFetch('/commands/toggle_pause', { method: 'POST', body: JSON.stringify({ paused: args.paused }) });
                    return { status: resp.ok ? 'ok' : 'error', content: [{ text: JSON.stringify(resp.json || {}) }] };
                }
                case 'report_telemetry': {
                    const payload = {
                        drone_id: args.drone_id,
                        battery: args.battery,
                        x: args.x, y: args.y, z: args.z,
                        status: args.status,
                        clear_target: args.clear_target,
                    };
                    const resp = await apiFetch('/telemetry', { method: 'POST', body: JSON.stringify(payload) });
                    return { status: resp.ok ? 'ok' : 'error', content: [{ text: JSON.stringify(resp.json || {}) }] };
                }
                default:
                    throw new Error(`Unsupported API tool: ${tool}`);
            }
        } catch (e) {
            throw e;
        }
    },
};

export async function connectApi() {
    await apiClient.connect();
}
