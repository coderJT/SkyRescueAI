/**
 * Renders the Heads-Up Display to display general environment statistics.
 * @param {*} state 
 * @param {*} mcpClient 
 */

export function registerHud(state, mcpClient) {
  const getPaused = state.getIsPaused
    ? () => state.getIsPaused()
    : () => !!state.isPaused;
  const setPaused = state.setIsPaused
    ? (v) => state.setIsPaused(v)
    : (v) => { state.isPaused = v; return v; };
  const markPauseStart = state.markPauseStart
    ? (t) => state.markPauseStart(t)
    : (t) => { state.pauseStartTime = t; };
  const addPausedDuration = state.addPausedDuration
    ? (now) => state.addPausedDuration(now)
    : (now) => { state.totalPausedTime = (state.totalPausedTime || 0) + (now - (state.pauseStartTime || 0)); };
  const toggleShowScanned = state.setShowScanned
    ? () => state.setShowScanned((v) => !v)
    : () => { state.showScannedSectors = !state.showScannedSectors; return state.showScannedSectors; };
  const setMoveSpeed = state.setMoveSpeed
    ? (v) => state.setMoveSpeed(v)
    : (v) => { state.MOVE_SPEED = v; return v; };

  window.togglePause = function () {
    const nowPaused = !getPaused();
    setPaused(nowPaused);

    const btn = document.getElementById('pause-btn');
    if (btn) {
      btn.innerHTML = nowPaused ? '▶ Resume' : '⏸ Pause';
      btn.style.color = '#7aa8cc';
      btn.style.borderColor = nowPaused ? 'rgba(122,168,204,0.3)' : 'rgba(74,158,255,0.25)';
      btn.style.background = nowPaused ? 'rgba(122,168,204,0.15)' : 'rgba(74,158,255,0.1)';
    }

    if (mcpClient && mcpClient.connected) {
      mcpClient.callTool('toggle_pause', { paused: nowPaused }).catch(e => console.warn(e));
    }

    if (nowPaused) {
      markPauseStart(performance.now());
    } else {
      addPausedDuration(performance.now());
    }
  };

  window.togglePanel = function (contentId, btnId) {
    const el = document.getElementById(contentId);
    const btn = document.getElementById(btnId);
    if (!el || !btn) return;
    const hidden = el.style.display === 'none';
    el.style.display = hidden ? '' : 'none';
    btn.textContent = hidden ? '[-]' : '[+]';
  };

  window.updateSpeed = function (v) {
    const newVal = setMoveSpeed(v / 100);
    const el = document.getElementById('speed-val');
    if (el) el.textContent = (newVal || v / 100).toFixed(2);
  };

  window.toggleScannedSectors = function () {
    const val = toggleShowScanned();
    const btn = document.getElementById('scan-toggle-btn');
    if (btn) {
      btn.style.background = val ? 'rgba(74,158,255,0.25)' : 'rgba(74,158,255,0.1)';
      btn.style.color = val ? '#a0c8e8' : '#7aa8cc';
    }
  };

  function updateCurrentTime() {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const timeStr = `${hours}:${minutes}:${seconds}`;
    const timeEl = document.getElementById('current-time');
    if (timeEl) timeEl.textContent = timeStr;
  }
  updateCurrentTime();
  setInterval(updateCurrentTime, 1000);

  // Connection status pinger (uses global mcpClient set by main.js)
  setInterval(() => {
    const dot = document.getElementById('llm-dot');
    if (!dot) return;
    const mc = window.mcpClient;
    if (mc && mc.connected) {
      dot.style.color = '#7aa8cc';
      dot.parentElement.title = 'Connected to MCP Server (API bridge)';
    } else {
      dot.style.color = '#b07060';
      dot.parentElement.title = 'MCP Server unreachable';
    }
  }, 2000);
}
