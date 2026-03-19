// Thought log utilities
export function initLogs(state, utils, mcpClient) {
  const { DRONE_COLORS, DRONE_NAMES, thoughtLogs } = state;

  function trimLog(idx) {
    const MAX_THOUGHT_LOGS = 100;
    const log = thoughtLogs[idx];
    while (log.length > MAX_THOUGHT_LOGS) log.shift();
  }

  function updateFilterButtons() {
    ['all', 'llm', 'mcp'].forEach(mode => {
      const btn = document.getElementById(`filter-${mode}`);
      if (btn) btn.classList.toggle('active', state.logFilter === mode);
    });
  }

  function setLogFilter(mode) {
    state.logFilter = mode;
    state.showMCP = (mode !== 'llm');
    updateFilterButtons();
    renderThoughts();
  }
  window.setLogFilter = setLogFilter;

  const reasonPrefixes = [
    '🧠 Let me think... ', '🧠 Okay so... ', '🧠 Hmm, looking at this... ',
    '🧠 Alright, I see that... ', '🧠 From what I can tell... ', '🧠 Let me figure this out... ',
    '🧠 Considering the situation... ', '🧠 So here\'s what I\'m seeing... ',
  ];
  let reasonIdx = 0;

  function addThought(droneIdx, type, msg) {
    if (state.missionComplete) return;
    const isLLM = type === 'llm';
    let reasonPrefix = reasonPrefixes[reasonIdx % reasonPrefixes.length];
    reasonIdx++;
    const prefixes = {
      'action': '', 'reason': reasonPrefix, 'danger': '', 'alert': '',
      'warning': '', 'info': '   ℹ ', 'phase': '', 'system': '⚙ SYSTEM: ',
    };
    if (type === 'reason') {
      msg = msg.replace(/\[OBSERVATION\]:/g, '<span class="reason-tag obs-tag">OBSERVING</span>')
               .replace(/\[RISK ASSESSMENT\]:/g, '<span class="reason-tag risk-tag">RISK CHECK</span>')
               .replace(/\[DECISION\]:/g, '<span class="reason-tag dec-tag">DECISION</span>');
    }
    const formattedMsg = (prefixes[type] || '') + msg;
    while (thoughtLogs.length < state.drones.length) thoughtLogs.push([]);
    const thoughtId = ++state.thoughtIdCounter;
    if (droneIdx === -1) {
      const t = { id: thoughtId, type, msg: formattedMsg, time: Date.now(), isMCP: false, isLLM, global: true };
      for (let i = 0; i < state.drones.length; i++) { thoughtLogs[i].push(t); trimLog(i); }
      return;
    }
    thoughtLogs[droneIdx].push({ id: thoughtId, type, msg: formattedMsg, time: Date.now(), isMCP: false, isLLM, global: false });
    trimLog(droneIdx);
  }

  function summariseResponse(name, resp) {
    if (!resp || typeof resp !== 'object') return String(resp ?? '');
    if (name === 'thermal_scan') {
      const cnt = resp.detected_count ?? resp.detected?.length ?? 0;
      const bat = resp.battery_after != null ? ` | my battery is at ${resp.battery_after}%` : '';
      return cnt > 0 ? `✅ I found ${cnt} survivor(s)!${bat}` : `✅ Sector looks clear — I don't see any survivors${bat}`;
    }
    if (name === 'scan_sector') {
      const haz = resp.hazard || resp.status || 'clear';
      const surv = resp.survivors_in_range != null ? ` | I detect ${resp.survivors_in_range} survivors in range` : '';
      return `✅ I've scanned it — hazard level: ${haz}${surv}`;
    }
    if (name === 'assign_target') return resp.error ? `❌ Something went wrong: ${resp.error}` : `✅ Got it, I'm targeting → ${resp.target || '?'}`;
    if (name === 'recall_for_charging') return `✅ I'm heading back — my battery is at ${resp.battery ?? '?'}%`;
    if (name === 'add_drone') return `✅ Fleet is now ${resp.fleet_size ?? '?'} strong | battery: ${resp.battery ?? 100}%`;
    if (name === 'start_mission') return `✅ Mission is live — I've placed ${resp.survivor_count ?? '?'} survivors`;
    if (resp.status) return `✅ ${resp.status}`;
    if (resp.error) return `❌ ${resp.error}`;
    const keys = Object.keys(resp).slice(0, 3);
    return keys.map(k => `${k}: ${resp[k]}`).join(' | ');
  }

  function addMCP(droneIdx, callType, toolName, args, response) {
    if (state.missionComplete) return;
    while (thoughtLogs.length <= droneIdx) thoughtLogs.push([]);
    const toolDescriptions = {
      'thermal_scan': (a) => `🔬 I'm running a thermal scan on sector ${a.sector || a.sector_id || '?'}`,
      'scan_sector': (a) => `📡 I'm doing a full sector scan of ${a.sector_id || '?'} (method: ${a.method || 'dedicated'})`,
      'assign_target': (a) => `🎯 I'm assigning ${a.drone_id || '?'} to sector ${a.sector_id || '?'}`,
      'recall_for_charging': (a) => `🔋 I'm recalling ${a.drone_id || '?'} back to the charging base`,
      'add_drone': (a) => `🚁 I'm deploying a new drone: ${a.drone_id || '?'}`,
      'start_mission': (a) => `🚀 I'm starting the mission (${a.active_drones || '?'} drones, ${a.survivor_count || '?'} survivors)`,
      'get_world_state': () => `🌍 I'm fetching the world state`,
    };
    const descFn = toolDescriptions[toolName];
    const callDesc = descFn ? descFn(args) : `⚡ ${toolName}(${Object.keys(args || {}).join(', ')})`;
    const respDesc = summariseResponse(toolName, response);
    const callMsg = `⚡ So I ${callDesc}`;
    const respMsg = `   ℹ ${respDesc}`;
    thoughtLogs[droneIdx].push({ type: 'mcp-call', msg: callMsg, time: Date.now(), isMCP: true, global: false });
    thoughtLogs[droneIdx].push({ type: 'mcp-resp', msg: respMsg, time: Date.now() + 1, isMCP: true, global: false });
    trimLog(droneIdx);
    if (mcpClient && mcpClient.connected) {
      return mcpClient.callTool(toolName, args).catch(e => console.warn(`[MCP Sync Error] Tool ${toolName} failed:`, e));
    }
    return Promise.resolve();
  }

  function renderThoughts() {
    const el = document.getElementById('thoughts');
    const parent = el.parentElement;
    let entries = [];
    if (state.activeDrone >= 0) {
      entries = thoughtLogs[state.activeDrone].map(t => ({ ...t, drone: state.activeDrone }));
    } else {
      const seenGlobalIds = new Set();
      for (let i = 0; i < state.drones.length; i++) {
        thoughtLogs[i].forEach(t => {
          if (t.global) {
            if (seenGlobalIds.has(t.id)) return;
            seenGlobalIds.add(t.id);
          }
          entries.push({ ...t, drone: i });
        });
      }
      entries.sort((a, b) => a.time - b.time || (a.id - b.id));
    }
    if (state.logFilter === 'llm') entries = entries.filter(t => t.isLLM);
    else if (state.logFilter === 'mcp') entries = entries.filter(t => t.isMCP);
    const MAX_THOUGHT_LOGS = 100;
    if (entries.length > MAX_THOUGHT_LOGS) entries = entries.slice(entries.length - MAX_THOUGHT_LOGS);
    let html = '';
    entries.forEach(t => {
      if (t.global) {
        html += `<div class="thought-entry ${t.type}">${t.msg}</div>`;
      } else {
        const color = DRONE_COLORS[t.drone] || '#aaa';
        const name = DRONE_NAMES[t.drone] || `drone_${t.drone + 1}`;
        const tag = `<span class="thought-drone-tag" style="background:${utils.hslWithAlpha(color,0.13)};color:${color}">${name}</span>`;
        html += `<div class="thought-entry ${t.type}">${tag} ${t.msg}</div>`;
      }
    });
    const distFromBottom = parent.scrollHeight - parent.scrollTop - parent.clientHeight;
    const wasAtBottom = distFromBottom <= 40;
    const prevScrollTop = parent.scrollTop;
    el.innerHTML = html;
    if (wasAtBottom) parent.scrollTop = parent.scrollHeight; else parent.scrollTop = prevScrollTop;
  }

  updateFilterButtons();

  return { addThought, addMCP, renderThoughts, setLogFilter, updateFilterButtons };
}
