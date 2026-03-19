// Lightweight MCP-over-HTTP client that targets the FastAPI bridge.
// No shim/fallback: connection must succeed or calls will throw.

const DEFAULT_API_BASE = 'http://localhost:8000';

async function apiFetch(path, options = {}) {
  const base = window.API_BASE || localStorage.getItem('API_BASE') || DEFAULT_API_BASE;
  const url = `${base}${path}`;
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) {}
  return { ok: res.ok, status: res.status, json, text };
}

export const mcpClient = {
  connected: false,
  async connect() {
    try {
      const ping = await apiFetch('/settings');
      if (ping.ok) {
        this.connected = true;
        return true;
      }
    } catch (e) {
      // propagate below
    }
    this.connected = false;
    throw new Error('MCP/API bridge unreachable; start API server.');
  },
  async callTool(name, args = {}) {
    // Map common MCP tool names to API endpoints
    const tool = name || '';
    if (!this.connected) {
      throw new Error('MCP client not connected');
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
        case 'get_all_drones': {
          const resp = await apiFetch('/drones');
          return { status: resp.ok ? 'ok' : 'error', content: [{ text: JSON.stringify(resp.json || {}) }] };
        }
        case 'get_drone_status': {
          const resp = await apiFetch('/drones');
          const one = resp.json && args.id ? { [args.id]: resp.json[args.id] } : resp.json;
          return { status: resp.ok ? 'ok' : 'error', content: [{ text: JSON.stringify(one || {}) }] };
        }
        case 'move_to':
        case 'assign_target': {
          const payload = {
            id: args.drone_id || args.id,
            sector_id: args.sector_id,
            reason: args.reason,
            x: args.x,
            y: args.y,
            z: args.z,
          };
          const resp = await apiFetch('/commands/set_target', { method: 'POST', body: JSON.stringify(payload) });
          return { status: resp.ok ? 'ok' : 'error', content: [{ text: JSON.stringify(resp.json || {}) }] };
        }
        case 'assign_targets': {
          const payload = { waiting: args.waiting };
          const resp = await apiFetch('/commands/assign', { method: 'POST', body: JSON.stringify(payload) });
          return { status: resp.ok ? 'ok' : 'error', content: [{ text: JSON.stringify(resp.json || {}) }] };
        }
        case 'thermal_scan':
        case 'scan_sector': {
          const payload = { id: args.drone_id || args.id, sector_id: args.sector || args.sector_id };
          const resp = await apiFetch('/commands/scan', { method: 'POST', body: JSON.stringify(payload) });
          return { status: resp.ok ? 'ok' : 'error', content: [{ text: JSON.stringify(resp.json || {}) }] };
        }
        case 'toggle_pause': {
          const resp = await apiFetch('/commands/toggle_pause', { method: 'POST', body: JSON.stringify({ paused: args.paused }) });
          return { status: resp.ok ? 'ok' : 'error', content: [{ text: JSON.stringify(resp.json || {}) }] };
        }
        case 'report_telemetry': {
          // No dedicated endpoint; ignore
          return { status: 'ok', content: [{ text: '{}' }] };
        }
        default:
          throw new Error(`Unsupported MCP tool: ${tool}`);
      }
    } catch (e) {
      throw e;
    }
  },
};

export async function connectMcp() {
  await mcpClient.connect();
}
