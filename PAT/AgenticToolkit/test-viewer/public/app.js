const SPEEDS = [1, 1.5, 2];

// Drift threshold beyond which audio<->transcript sync is disabled (the
// alignment can be off by ~1-2s due to WS connect + greeting wait, but if it
// drifts much more than that we'd rather show nothing than the wrong line).
const SYNC_DRIFT_DISABLE_MS = 3000;

const state = {
  scenarios: [],   // flat list (newest first)
  groups: [],      // run groups (newest first)
  byName: new Map(),
  selectedRunId: null,
  selectedScenario: null,
  detailsOpen: false, // accordion open/closed (collapsed by default)
  // per-scenario detail cache: name -> { result, transcript }
  detailCache: new Map(),
  // audio UI state, persisted across re-renders within a single scenario detail
  audioState: { current: null, speed: 1 },
  // transcript sync state
  syncState: { activeIndex: -1, syncEnabled: true },
};

const els = {
  scenarioList: document.getElementById('scenario-list'),
  scenariosPills: document.getElementById('scenarios-pills'),
  detail: document.getElementById('detail'),
  runSwitch: document.getElementById('run-switch'),
  runSwitchLabel: document.getElementById('run-switch-label'),
  runPicker: document.getElementById('run-picker'),
};


// run-picker dropdown wiring
els.runSwitch.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleRunPicker();
});
document.addEventListener('click', (e) => {
  if (!els.runPicker.hidden && !els.runPicker.contains(e.target) && e.target !== els.runSwitch) {
    closeRunPicker();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.runPicker.hidden) closeRunPicker();
});

function toggleRunPicker() {
  if (els.runPicker.hidden) openRunPicker(); else closeRunPicker();
}
function openRunPicker() {
  els.runPicker.hidden = false;
  els.runSwitch.setAttribute('aria-expanded', 'true');
}
function closeRunPicker() {
  els.runPicker.hidden = true;
  els.runSwitch.setAttribute('aria-expanded', 'false');
}

async function loadAll() {
  els.scenarioList.innerHTML = '<div style="padding:16px;color:var(--text-faint);font-size:13px;">loading...</div>';
  try {
    const r = await fetch('/api/run-groups', { cache: 'no-store' });
    const data = await r.json();
    state.scenarios = data.scenarios || [];
    state.groups = data.groups || [];
    state.byName = new Map(state.scenarios.map(s => [s.name, s]));

    // pick a default run if needed (latest)
    if (!state.selectedRunId || !state.groups.find(g => g.id === state.selectedRunId)) {
      state.selectedRunId = state.groups[0]?.id ?? null;
    }
    // pick a default scenario in the selected run if needed
    const curGroup = state.groups.find(g => g.id === state.selectedRunId);
    if (curGroup && (!state.selectedScenario || !curGroup.scenarioNames.includes(state.selectedScenario))) {
      state.selectedScenario = curGroup.scenarioNames[0] ?? null;
    }

    renderRunSwitch();
    renderRunPicker();
    renderScenarios();
    renderDetailIfReady();
  } catch (e) {
    els.scenarioList.innerHTML = `<div class="error-banner">failed to load: ${escapeHtml(String(e))}</div>`;
  }
}

function formatRunDate(ts) {
  if (!ts) return 'unknown time';
  return new Date(ts).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function renderRunSwitch() {
  const groups = state.groups;
  const cur = groups.find(g => g.id === state.selectedRunId);
  const isLatest = cur && cur.id === groups[0]?.id;
  if (!cur) {
    els.runSwitchLabel.textContent = 'no runs';
  } else {
    els.runSwitchLabel.textContent = `${formatRunDate(cur.startTs)}${isLatest ? ' · Latest' : ''}`;
  }
}

function renderRunPicker() {
  const groups = state.groups;
  const html = groups.map((g, idx) => {
    const active = g.id === state.selectedRunId ? 'active' : '';
    const isLatest = idx === 0;
    return `<div class="run-pick-item ${active}" data-id="${escapeAttr(g.id)}" role="option">
      <div class="ts">${escapeHtml(formatRunDate(g.startTs))}${isLatest ? ' · Latest' : ''}</div>
    </div>`;
  }).join('');
  els.runPicker.innerHTML = html || '<div style="padding:16px;color:var(--text-faint);font-size:13px;">no runs</div>';
  els.runPicker.querySelectorAll('.run-pick-item').forEach(node => {
    node.addEventListener('click', () => {
      selectRun(node.dataset.id);
      closeRunPicker();
    });
  });
}

function formatTimeShort(ms) {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function selectRun(id) {
  state.selectedRunId = id;
  const g = state.groups.find(x => x.id === id);
  // reset scenario to first in the group
  state.selectedScenario = g?.scenarioNames[0] ?? null;
  // reset audio + sync
  state.audioState = { current: null, speed: 1 };
  state.syncState = { activeIndex: -1, syncEnabled: true };
  renderRunSwitch();
  renderRunPicker();
  renderScenarios();
  renderDetailIfReady();
}

function renderScenarios() {
  const g = state.groups.find(x => x.id === state.selectedRunId);
  const names = g?.scenarioNames ?? [];
  const items = names
    .map(n => state.byName.get(n))
    .filter(Boolean);

  // wide (sidebar)
  const listHtml = items.map(s => {
    const dotCls = s.passed === true ? 'pass' : s.passed === false ? 'fail' : '';
    const dur = s.durationMs != null ? `${(s.durationMs / 1000).toFixed(1)}s` : '';
    const active = s.name === state.selectedScenario ? 'active' : '';
    return `<div class="scenario-item ${active}" data-name="${escapeAttr(s.name)}">
      <span class="dot ${dotCls}"></span>
      <span class="name">${escapeHtml(s.scenario)}</span>
      <span class="dur">${escapeHtml(dur)}</span>
    </div>`;
  }).join('');
  els.scenarioList.innerHTML = listHtml || '<div style="padding:16px;color:var(--text-faint);font-size:13px;">no scenarios</div>';
  els.scenarioList.querySelectorAll('.scenario-item').forEach(node => {
    node.addEventListener('click', () => selectScenario(node.dataset.name));
  });

  // narrow (pills)
  els.scenariosPills.innerHTML = items.map(s => {
    const dotCls = s.passed === true ? 'pass' : s.passed === false ? 'fail' : '';
    const active = s.name === state.selectedScenario ? 'active' : '';
    return `<button class="pill ${active}" data-name="${escapeAttr(s.name)}">
      <span class="dot ${dotCls}"></span>
      <span>${escapeHtml(s.scenario)}</span>
    </button>`;
  }).join('');
  els.scenariosPills.querySelectorAll('.pill').forEach(node => {
    node.addEventListener('click', () => selectScenario(node.dataset.name));
  });
}

function selectScenario(name) {
  state.selectedScenario = name;
  // reset audio + sync since we're switching scenarios
  state.audioState = { current: null, speed: 1 };
  state.syncState = { activeIndex: -1, syncEnabled: true };
  renderScenarios();
  renderDetailIfReady();
}

async function renderDetailIfReady() {
  const name = state.selectedScenario;
  if (!name) {
    els.detail.innerHTML = '<div class="placeholder">Select a scenario.</div>';
    return;
  }
  const cached = state.detailCache.get(name);
  if (cached) {
    renderDetail(state.byName.get(name), cached.result, cached.transcript);
    return;
  }
  els.detail.innerHTML = '<div class="placeholder">loading...</div>';
  try {
    const [resultR, transcriptR] = await Promise.all([
      fetch(`/api/run/${encodeURIComponent(name)}/result.json`, { cache: 'no-store' }),
      fetch(`/api/run/${encodeURIComponent(name)}/transcript.json`, { cache: 'no-store' }),
    ]);
    const result = resultR.ok ? await resultR.json() : null;
    const transcript = transcriptR.ok ? await transcriptR.json() : null;
    state.detailCache.set(name, { result, transcript });
    if (state.selectedScenario === name) {
      renderDetail(state.byName.get(name), result, transcript);
    }
  } catch (e) {
    els.detail.innerHTML = `<div class="error-banner">failed to load scenario: ${escapeHtml(String(e))}</div>`;
  }
}

function renderDetail(run, result, transcript) {
  const passed = result?.passed;
  const verdictCls = passed === true ? 'pass' : passed === false ? 'fail' : 'unknown';
  const verdictLabel = passed === true ? 'PASS' : passed === false ? 'FAIL' : 'UNKNOWN';
  const startedAt = transcript?.startTs
    ? new Date(transcript.startTs).toLocaleString()
    : (run?.startTs ? new Date(run.startTs).toLocaleString() : '—');
  const durSec = result?.durationMs != null ? (result.durationMs / 1000).toFixed(2) + 's' : '—';
  const m = transcript?.metrics ?? {};
  const ack = m.ackLatenciesMs?.length ? avg(m.ackLatenciesMs).toFixed(0) + 'ms' : '—';
  const chat = m.chatLatenciesMs?.length ? avg(m.chatLatenciesMs).toFixed(0) + 'ms' : '—';

  const judge = result?.outcomes?.find(o => o.stepKind === 'judge')?.judge;
  const judgeReason = judge?.reason ?? '';
  const verdictTip = judgeReason
    ? `Judge: ${judge.passed ? 'PASS' : 'FAIL'}\n${judgeReason}`
    : '';

  const wavs = run?.wavs ?? [];
  const hasAudio = wavs.length > 0;
  const detailsOpenAttr = state.detailsOpen ? 'open' : '';

  const html = `
    <div class="detail-scroll">
      <div class="detail-head">
        <h2>${escapeHtml(result?.scenario ?? run?.scenario ?? run?.name ?? '')}</h2>
        <span class="verdict ${verdictCls}"
              ${verdictTip ? `data-tip="${escapeAttr(verdictTip)}" title="${escapeAttr(verdictTip)}"` : ''}>
          ${verdictLabel}
        </span>
      </div>
      <details class="details-accordion" ${detailsOpenAttr} id="details-acc">
        <summary class="details-summary">Details</summary>
        <div class="details-body">
          <div class="metrics">
            ${metricCard('Duration', durSec)}
            ${metricCard('Ack latency', ack)}
            ${metricCard('Chat latency', chat)}
            ${metricCard('User turns', m.userTurnCount ?? '—')}
            ${metricCard('Agent utterances', m.agentUtteranceCount ?? '—')}
            ${metricCard('Agent chats', m.agentChatCount ?? '—')}
            ${metricCard('Error fallbacks', m.errorFallbackCount ?? '—')}
          </div>

          ${judge ? `<div class="judge-box ${judge.passed ? 'pass' : 'fail'}">
            <div><strong>Judge: ${judge.passed ? 'PASS' : 'FAIL'}</strong></div>
            <div class="reason">${escapeHtml(judge.reason ?? '')}</div>
          </div>` : ''}

          <div class="section-title">Steps</div>
          <div class="steps">
            ${(result?.outcomes ?? []).map(renderStep).join('') || '<div style="color:var(--text-faint);font-size:13px;">no steps</div>'}
          </div>
        </div>
      </details>

      ${hasAudio
        ? `<div class="audio-block" id="audio-block"></div>`
        : `<div class="audio-empty">no audio for this run — was text mode</div>`}

      <div class="transcript-section">
        <div class="transcript" id="transcript">
          ${renderTranscript(transcript)}
        </div>
      </div>
    </div>
  `;
  els.detail.innerHTML = html;

  // wire accordion toggle to keep state across re-renders
  const acc = document.getElementById('details-acc');
  acc?.addEventListener('toggle', () => {
    state.detailsOpen = acc.open;
  });

  // wire trace copy buttons (event delegation on the transcript container)
  const transcriptEl = document.getElementById('transcript');
  transcriptEl?.addEventListener('click', onTranscriptClick);

  if (hasAudio) mountAudio(run.name, wavs, transcript);
}

function metricCard(k, v) {
  return `<div class="metric"><div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(String(v))}</div></div>`;
}

function renderStep(o) {
  const cls = o.ok ? 'pass' : 'fail';
  const detailText = o.details ?? (o.judge?.reason ?? '');
  return `<div class="step ${cls}">
    <div class="step-dot"></div>
    <div class="kind">${escapeHtml(o.stepKind)}</div>
    <div>
      <div class="det">${escapeHtml(detailText)}</div>
      ${o.error ? `<div class="err">${escapeHtml(o.error)}</div>` : ''}
    </div>
  </div>`;
}

function renderTranscript(t) {
  if (!t?.entries?.length) return '<div style="color:var(--text-faint);font-size:13px;">no entries</div>';
  const start = t.startTs ?? t.entries[0].ts;
  const html = t.entries.map((e, idx) => {
    const offset = e.ts - start;
    const offStr = `+${offset}ms`;
    if (e.source === 'trace') {
      return renderTraceRow(e, idx, offStr, offset);
    }
    const srcCls = e.source ?? 'system';
    return `<div class="t-row" data-idx="${idx}" data-offset-ms="${offset}">
      <span class="t-ts">${escapeHtml(offStr)}</span>
      <span class="t-src ${escapeAttr(srcCls)}">${escapeHtml(srcCls)}</span>
      <span class="t-text">${escapeHtml(e.text ?? '')}</span>
    </div>`;
  }).join('');
  // wire trace expand/copy after we mount
  // (handled by event delegation below)
  return html;
}

function renderTraceRow(e, idx, offStr, offset) {
  const trace = e.metadata?.trace ?? {};
  const ok = trace.ok !== false;
  const layer = trace.layer ?? 'trace';
  const latency = trace.latencyMs != null ? `${trace.latencyMs}ms` : '?ms';
  const failTag = ok ? '' : ', FAILED';
  const summary = `[TRACE] ${layer} (${latency}${failTag})`;
  const errorText = !ok && trace.error ? trace.error : '';
  const sysText = trace.systemPrompt ?? '';
  const userText = trace.userMessage ?? '';
  const respText = trace.response;
  const respIsNull = respText == null;

  const okCls = ok ? '' : 'failed';

  // Note: <details> handles expansion natively; we add copy buttons inside.
  return `<details class="trace-row ${okCls}" data-idx="${idx}" data-offset-ms="${offset}">
    <summary class="trace-summary">
      <span class="t-ts">${escapeHtml(offStr)}</span>
      <span class="t-src trace">trace</span>
      <span class="trace-text">${escapeHtml(summary)}</span>
    </summary>
    <div class="trace-body">
      ${errorText ? `<div class="trace-error">error: ${escapeHtml(errorText)}</div>` : ''}
      ${traceSection('System prompt', sysText, false)}
      ${traceSection('User message', userText, false)}
      ${traceSection('Response', respIsNull ? '(no response — failed)' : (respText ?? ''), respIsNull)}
    </div>
  </details>`;
}

function traceSection(label, text, isPlaceholder) {
  // We stash the raw text in a hidden <textarea> so the copy button can grab
  // it without re-decoding HTML entities. The visible <pre> is HTML-escaped.
  return `<div class="trace-section ${isPlaceholder ? 'placeholder' : ''}">
    <div class="trace-section-head">
      <span class="trace-section-label">${escapeHtml(label)}</span>
      ${isPlaceholder ? '' : `<button type="button" class="trace-copy" data-copy-section title="Copy to clipboard">Copy</button>`}
    </div>
    <textarea class="trace-raw" hidden readonly>${escapeHtml(text)}</textarea>
    <pre class="trace-pre">${escapeHtml(text)}</pre>
  </div>`;
}

// Event delegation for trace copy buttons. Mounted once in setupTranscriptDelegation().
function onTranscriptClick(ev) {
  const btn = ev.target.closest('.trace-copy');
  if (!btn) return;
  ev.preventDefault();
  ev.stopPropagation();
  const section = btn.closest('.trace-section');
  if (!section) return;
  const ta = section.querySelector('.trace-raw');
  const text = ta ? ta.value : '';
  copyToClipboard(text).then(() => {
    const old = btn.textContent;
    btn.textContent = 'Copied';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = old;
      btn.classList.remove('copied');
    }, 1200);
  }).catch(() => {
    btn.textContent = 'Failed';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
  });
}

// Stop click on <summary> from being interpreted by transcript-sync etc.
// (no current sync logic on click, but future-proof.)
function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  // Fallback: select+execCommand
  return new Promise((resolve, reject) => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error('execCommand failed'));
    } catch (e) { reject(e); }
  });
}

function mountAudio(runName, wavs, transcript) {
  const block = document.getElementById('audio-block');
  if (!block) return;
  const order = ['call.wav', 'user.wav', 'agent.wav'].filter(w => wavs.includes(w));
  if (state.audioState.current == null || !order.includes(state.audioState.current)) {
    state.audioState.current = order[0];
  }
  if (state.audioState.speed == null) state.audioState.speed = 1;

  // Build offsets array for sync (transcript entry idx -> offsetMs).
  // Only meaningful when playing call.wav (the merged stream that lines up with
  // scenario start). user.wav / agent.wav are isolated streams with different
  // alignment, so we disable sync for those.
  const transcriptStart = transcript?.startTs ?? transcript?.entries?.[0]?.ts ?? null;
  const offsets = (transcript?.entries ?? []).map(e =>
    transcriptStart != null ? e.ts - transcriptStart : 0
  );

  function render() {
    const current = state.audioState.current;
    const speed = state.audioState.speed;
    block.innerHTML = `
      <div class="audio-tabs">
        ${order.map(w => `<button class="${w === current ? 'active' : ''}" data-wav="${escapeAttr(w)}">${escapeHtml(w)}</button>`).join('')}
      </div>
      <div class="audio-row">
        <audio id="audio-el"
               controls
               preload="metadata"
               controlsList="nodownload noplaybackrate noremoteplayback"
               disableRemotePlayback
               src="/api/run/${encodeURIComponent(runName)}/${encodeURIComponent(current)}"></audio>
        <div class="speed-buttons">
          ${SPEEDS.map(s => `<button class="${s === speed ? 'active' : ''}" data-speed="${s}">${s}x</button>`).join('')}
        </div>
        <div class="audio-time" id="audio-time">0:00 / 0:00</div>
      </div>
    `;
    const audio = document.getElementById('audio-el');
    const timeEl = document.getElementById('audio-time');
    audio.playbackRate = speed;

    // Reset sync state
    state.syncState = { activeIndex: -1, syncEnabled: current === 'call.wav' && offsets.length > 0 };

    audio.addEventListener('loadedmetadata', () => updateTime(audio, timeEl));
    audio.addEventListener('durationchange', () => updateTime(audio, timeEl));
    audio.addEventListener('timeupdate', () => {
      updateTime(audio, timeEl);
      maybeSync(audio, offsets);
    });
    audio.addEventListener('seeked', () => maybeSync(audio, offsets));

    block.querySelectorAll('[data-wav]').forEach(b => {
      b.addEventListener('click', () => {
        state.audioState.current = b.dataset.wav;
        render();
      });
    });
    block.querySelectorAll('[data-speed]').forEach(b => {
      b.addEventListener('click', () => {
        state.audioState.speed = Number(b.dataset.speed);
        audio.playbackRate = state.audioState.speed;
        block.querySelectorAll('[data-speed]').forEach(x =>
          x.classList.toggle('active', Number(x.dataset.speed) === state.audioState.speed)
        );
      });
    });
  }
  render();
}

function maybeSync(audio, offsets) {
  if (!state.syncState.syncEnabled || offsets.length === 0) return;
  const tMs = audio.currentTime * 1000;

  // Find the entry with the largest offset <= tMs (binary search ok, but linear is fine).
  let idx = -1;
  for (let i = 0; i < offsets.length; i++) {
    if (offsets[i] <= tMs) idx = i; else break;
  }

  // If audio is far past the last transcript offset, drift may be too large —
  // disable sync.
  if (idx === offsets.length - 1 && tMs - offsets[idx] > SYNC_DRIFT_DISABLE_MS + 30000) {
    state.syncState.syncEnabled = false;
    clearActiveLine();
    return;
  }

  if (idx === state.syncState.activeIndex) return;
  state.syncState.activeIndex = idx;

  const transcriptEl = document.getElementById('transcript');
  if (!transcriptEl) return;
  transcriptEl.querySelectorAll('.t-row.active').forEach(n => n.classList.remove('active'));
  if (idx >= 0) {
    const node = transcriptEl.querySelector(`.t-row[data-idx="${idx}"]`);
    if (node) node.classList.add('active');
  }
}

function clearActiveLine() {
  const transcriptEl = document.getElementById('transcript');
  transcriptEl?.querySelectorAll('.t-row.active').forEach(n => n.classList.remove('active'));
}

function updateTime(audio, el) {
  if (!el) return;
  el.textContent = `${fmtTime(audio.currentTime)} / ${fmtTime(audio.duration)}`;
}

function fmtTime(s) {
  if (!Number.isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function avg(xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

loadAll();
