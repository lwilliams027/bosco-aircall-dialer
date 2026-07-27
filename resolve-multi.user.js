// ==UserScript==
// @name         Bosco Resolve 3+ Notes
// @namespace    local.sa.resolvemulti
// @version      1.0
// @updateURL    https://raw.githubusercontent.com/lwilliams027/bosco-aircall-dialer/main/resolve-multi.user.js
// @downloadURL  https://raw.githubusercontent.com/lwilliams027/bosco-aircall-dialer/main/resolve-multi.user.js
// @description  One-off cleanup: resolve every Tech Note call that has 3+ notes. Reuses the dialer's scan for note counts, opens each, re-verifies 3+ notes, then sets the call status to Resolved. Preview + confirm before it touches anything.
// @match        https://bosco.serviceassistant.com/*
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

(function () {
  'use strict';
  if (!/CallLog/i.test(location.href)) return;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---- reuse the dialer's published scan (note counts) ----
  const readShared = () => { try { const st = JSON.parse(localStorage.getItem('sa_shared_queue') || 'null'); return (st && Array.isArray(st.q)) ? st : null; } catch (e) { return null; } };

  // ---- DOM helpers (call log lead detail + resolve) ----
  const realNotes = () => Array.from(document.querySelectorAll('div.note.container')).filter((n) => n.id !== 'NewNote' && !n.classList.contains('add-note') && !n.classList.contains('system') && n.offsetParent !== null);
  const notesSig = () => realNotes().map((n) => n.id).join(',');
  const openLeadRow = (row) => (row.querySelector('.stronger') || row.querySelector('.listView') || row).click();
  async function waitForNotes(prevSig) { const start = performance.now(); while (performance.now() - start < 2500) { await sleep(120); if (notesSig() !== prevSig) { await sleep(300); return true; } } return false; }
  function scrollContainer() { const r = document.querySelector('div.callRow'); if (!r) return null; let el = r.parentElement; while (el && el !== document.body) { const s = getComputedStyle(el); if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 5) return el; el = el.parentElement; } return null; }
  async function findRow(acct) {
    let el = document.querySelector(`div.callRow[data-accountnumber="${acct}"]`); if (el) return el;
    const sc = scrollContainer(); if (!sc) return null;
    for (let k = 0; k < 60; k++) {
      el = document.querySelector(`div.callRow[data-accountnumber="${acct}"]`);
      if (el) { el.scrollIntoView({ block: 'center' }); await sleep(150); return el; }
      const before = sc.scrollTop; sc.scrollTop = Math.min(sc.scrollTop + sc.clientHeight * 0.85, sc.scrollHeight); await sleep(220);
      if (sc.scrollTop <= before + 2) break;
    }
    return document.querySelector(`div.callRow[data-accountnumber="${acct}"]`);
  }
  async function resolveStatus() {
    const st = document.querySelector('#callStatus'); if (!st) { console.warn('[rm] #callStatus not found'); return false; }
    st.click(); await sleep(450); let done = false;
    const sel = document.querySelector('.editable-container select, .editableform select');
    if (sel) { const opt = Array.from(sel.options).find((o) => /^\s*resolved\s*$/i.test(o.text)); if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); done = true; } }
    if (!done) { const a = Array.from(document.querySelectorAll('.editable-container .dropdown-menu li a, .dropdown-menu.inner li a')).find((x) => /^\s*resolved\s*$/i.test(x.textContent)); if (a) { a.click(); done = true; } }
    await sleep(200); const chk = document.querySelector('.editable-submit, .editableform button[type=submit]');
    if (chk) chk.click(); else { console.warn('[rm] submit not found'); return false; }
    await sleep(700); return true;
  }

  // ---- ledger of what we've resolved (skip on re-run) ----
  let resolved = {}; try { resolved = GM_getValue('rm_resolved', {}) || {}; } catch (e) { resolved = {}; }
  const isResolved = (acct) => Object.prototype.hasOwnProperty.call(resolved, acct);
  function markResolved(acct, name) { resolved[acct] = { name, when: Date.now() }; try { GM_setValue('rm_resolved', resolved); } catch (e) {} }

  // ---- state ----
  let working = false, list = [];
  let statusMsg = 'Build the list of Tech Notes with 3+ notes.';
  const setStatus = (s) => { statusMsg = s; };

  function build() {
    const st = readShared();
    if (!st) { list = []; setStatus('No dialer scan found. In the dialer press f to build the queue, then Build here.'); render(); return; }
    const seen = new Set();
    list = st.q.filter((l) => l && l.type === 'tech' && l.acct && (l.noteCount || 0) >= 3 && !isResolved(String(l.acct)))
      .map((l) => ({ acct: String(l.acct), name: l.name || '(lead)', phone: l.phone || '', notes: l.noteCount || 0 }))
      .filter((x) => { if (seen.has(x.acct)) return false; seen.add(x.acct); return true; });
    setStatus(list.length ? `${list.length} Tech Notes have 3+ notes — review, then Resolve All.` : 'None found with 3+ notes.');
    render();
  }

  async function resolveAll() {
    if (working) { working = false; return; }          // second click = stop
    if (!list.length) return;
    const todo = list.filter((it) => !it.done);
    if (!confirm(`Resolve ${todo.length} Tech Notes that have 3+ notes?\n\nEach is opened, re-checked for 3+ notes, then set to Resolved. This clears them from the call log.`)) return;
    working = true; let done = 0, skipped = 0, failed = 0;
    for (const it of todo) {
      if (!working) break;
      setStatus(`Resolving ${done + skipped + failed + 1}/${todo.length} — ${it.name}…`); render();
      const row = await findRow(it.acct);
      if (!row) { it.failed = true; failed++; console.warn('[rm] row not found', it.acct); render(); continue; }
      const prev = notesSig(); openLeadRow(row); await waitForNotes(prev);
      if (realNotes().length < 3) { it.skipped = true; skipped++; render(); await sleep(300); continue; }   // safety: only if truly 3+
      let ok = false; try { ok = await resolveStatus(); } catch (e) { console.error('[rm]', e); }
      if (ok) { it.done = true; done++; markResolved(it.acct, it.name); } else { it.failed = true; failed++; }
      render(); await sleep(600);
    }
    working = false;
    setStatus(`Done — ${done} resolved${skipped ? `, ${skipped} skipped (not 3+ anymore)` : ''}${failed ? `, ${failed} failed` : ''}.`);
    render();
  }

  // ---- panel ----
  const style = document.createElement('style');
  style.textContent = `
  #rmp{position:fixed;right:14px;bottom:14px;z-index:2147482900;width:320px;max-height:78vh;display:flex;flex-direction:column;
    background:#141d27;color:#e8eef4;border:1px solid #2a3a48;border-radius:14px;font:13px/1.4 system-ui,Segoe UI,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.5)}
  #rmp.min{max-height:none}
  #rmp .hd{display:flex;align-items:center;gap:8px;padding:11px 13px;background:#c0392b;border-radius:14px 14px 0 0}
  #rmp .hd b{font-size:14px;flex:1}
  #rmp .hd .x{cursor:pointer;font-size:16px;opacity:.9}
  #rmp .bd{padding:12px 13px;overflow:auto} #rmp.min .bd{display:none}
  #rmp button{border:0;border-radius:10px;font-weight:800;color:#fff;cursor:pointer;font-family:inherit;padding:12px 8px;font-size:13px;width:100%}
  #rmp .scan{background:#22303c;margin-bottom:8px}
  #rmp .go{background:#c0392b;margin-top:9px} #rmp .go:disabled{opacity:.4;cursor:default}
  #rmp .st{margin:6px 0 8px;color:#9fb4c6;font-size:12px;min-height:16px}
  #rmp ul{list-style:none;margin:8px 0 0;padding:0}
  #rmp li{border:1px solid #26333f;border-radius:9px;padding:7px 9px;margin-bottom:6px;background:#101923;display:flex;align-items:center;gap:8px}
  #rmp li.done{border-color:#3a6b2a;background:#12240f} #rmp li.failed{border-color:#7a2a2a;background:#241010} #rmp li.skipped{opacity:.5}
  #rmp .nm{font-weight:700;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #rmp .ct{background:#3a2a12;color:#ffd28a;font-size:11px;font-weight:800;padding:2px 7px;border-radius:6px;flex-shrink:0}
  #rmp .stt{font-size:11px;font-weight:800;flex-shrink:0} #rmp .stt.g{color:#7BBF43} #rmp .stt.r{color:#ffb3ab}
  #rmp .foot{color:#8ea3b5;font-size:11px;margin-top:10px}
  `;
  document.documentElement.appendChild(style);
  const panel = document.createElement('div'); panel.id = 'rmp'; document.body.appendChild(panel);

  function render() {
    const pend = list.filter((it) => !it.done).length;
    panel.innerHTML = `
      <div class="hd"><b>✅ Resolve 3+ Notes</b><span class="x" id="rmmin">–</span></div>
      <div class="bd">
        <button class="scan" id="rmbuild" ${working ? 'disabled' : ''}>BUILD LIST</button>
        <div class="st">${esc(statusMsg)}</div>
        <button class="go" id="rmgo" ${(!list.length) ? 'disabled' : ''}>${working ? 'STOP' : `RESOLVE ALL (${pend})`}</button>
        <ul>${list.map((it) => `
          <li class="${it.done ? 'done' : ''}${it.failed ? ' failed' : ''}${it.skipped ? ' skipped' : ''}">
            <span class="nm">${esc(it.name)}</span>
            <span class="ct">${it.notes} notes</span>
            ${it.done ? '<span class="stt g">✓</span>' : it.failed ? '<span class="stt r">fail</span>' : it.skipped ? '<span class="stt">&lt;3</span>' : ''}
          </li>`).join('')}</ul>
        <div class="foot">Already resolved by this tool: ${Object.keys(resolved).length}</div>
      </div>`;
    panel.querySelector('#rmmin').onclick = () => panel.classList.toggle('min');
    panel.querySelector('#rmbuild').onclick = build;
    panel.querySelector('#rmgo').onclick = resolveAll;
  }
  render();
})();
