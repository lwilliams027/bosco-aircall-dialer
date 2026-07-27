// ==UserScript==
// @name         Bosco Texted Split
// @namespace    local.sa.textedsplit
// @version      1.1
// @updateURL    https://raw.githubusercontent.com/lwilliams027/bosco-aircall-dialer/main/texted-split.user.js
// @downloadURL  https://raw.githubusercontent.com/lwilliams027/bosco-aircall-dialer/main/texted-split.user.js
// @description  Splits Tech Notes into those that HAVE a "text sent / quote texted" note vs those that don't, with an A/B breakdown (sod price / no-price, dollar, leaf). Copy each list. Reads the dialer's scan.
// @match        https://bosco.serviceassistant.com/*
// @run-at       document-idle
// @grant        GM_setClipboard
// ==/UserScript==

(function () {
  'use strict';
  if (!/CallLog/i.test(location.href)) return;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const readShared = () => { try { const st = JSON.parse(localStorage.getItem('sa_shared_queue') || 'null'); return (st && Array.isArray(st.q)) ? st : null; } catch (e) { return null; } };

  // ---- open a lead in the call log + set status to Resolved ----
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
    const st = document.querySelector('#callStatus'); if (!st) return false;
    st.click(); await sleep(450); let done = false;
    const sel = document.querySelector('.editable-container select, .editableform select');
    if (sel) { const opt = Array.from(sel.options).find((o) => /^\s*resolved\s*$/i.test(o.text)); if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); done = true; } }
    if (!done) { const a = Array.from(document.querySelectorAll('.editable-container .dropdown-menu li a, .dropdown-menu.inner li a')).find((x) => /^\s*resolved\s*$/i.test(x.textContent)); if (a) { a.click(); done = true; } }
    await sleep(200); const chk = document.querySelector('.editable-submit, .editableform button[type=submit]');
    if (chk) chk.click(); else return false;
    await sleep(700); return true;
  }
  let working = false;
  async function resolveTexted() {
    if (working) { working = false; return; }                        // second click = stop
    const todo = texted.filter((r) => !r.done);
    if (!todo.length) return;
    if (!confirm(`Resolve ${todo.length} leads that already have a texted note?\n\nEach is opened and set to Resolved. This clears them from the call log.`)) return;
    working = true; let done = 0, failed = 0;
    for (const r of todo) {
      if (!working) break;
      statusMsg = `Resolving ${done + failed + 1}/${todo.length} — ${r.name}…`; render();
      const row = await findRow(r.acct);
      if (!row) { r.failed = true; failed++; render(); continue; }
      const prev = notesSig(); openLeadRow(row); await waitForNotes(prev);
      let ok = false; try { ok = await resolveStatus(); } catch (e) { console.error('[ts]', e); }
      if (ok) { r.done = true; done++; } else { r.failed = true; failed++; }
      render(); await sleep(600);
    }
    working = false; statusMsg = `Resolved ${done}${failed ? `, ${failed} failed` : ''} of the texted leads.`; render();
  }

  // classify a lead's texted note into a bucket
  function bucketOf(l) {
    if (!l.texted) return 'none';
    const t = (l.tnote || '').toLowerCase();
    if (/sod webworm text sent \(no price\)/.test(t)) return 'sodNo';
    if (/sod webworm text sent \(price\)/.test(t)) return 'sodPrice';
    if (/dollar spot quote texted/.test(t)) return 'dollar';
    if (/leaf spot quote texted/.test(t)) return 'leaf';
    return 'other';
  }
  const LABELS = { sodPrice: 'Sod — price', sodNo: 'Sod — no price', dollar: 'Dollar spot', leaf: 'Leaf spot', other: 'Texted (other)' };

  let texted = [], notTexted = [], counts = {};
  let statusMsg = 'Build to split Tech Notes by whether they have a texted note.';
  let openList = '';

  function build() {
    const st = readShared();
    if (!st) { texted = []; notTexted = []; statusMsg = 'No dialer scan found. In the dialer press f, then Build here.'; render(); return; }
    const seen = new Set();
    const tech = st.q.filter((l) => l && l.type === 'tech' && l.acct).filter((l) => { const k = String(l.acct); if (seen.has(k)) return false; seen.add(k); return true; });
    texted = []; notTexted = []; counts = { sodPrice: 0, sodNo: 0, dollar: 0, leaf: 0, other: 0 };
    for (const l of tech) {
      const b = bucketOf(l);
      const row = { acct: String(l.acct), name: l.name || '(lead)', phone: l.phone || '', bucket: b, note: l.tnote || '' };
      if (b === 'none') notTexted.push(row);
      else { texted.push(row); counts[b]++; }
    }
    statusMsg = `${texted.length} have a texted note · ${notTexted.length} don't (of ${tech.length} tech notes).`;
    render();
  }

  function copyList(rows, title) {
    const lines = [`# ${title} (${rows.length})`, 'Name\tPhone\tAcct\tNote'];
    rows.forEach((r) => lines.push(`${r.name}\t${r.phone}\t${r.acct}\t${r.note || (r.bucket === 'none' ? '' : LABELS[r.bucket] || '')}`));
    try { GM_setClipboard(lines.join('\n')); statusMsg = `Copied ${rows.length} — ${title}.`; render(); } catch (e) {}
  }

  const style = document.createElement('style');
  style.textContent = `
  #tsp{position:fixed;right:14px;top:64px;z-index:2147482800;width:330px;max-height:82vh;display:flex;flex-direction:column;
    background:#141d27;color:#e8eef4;border:1px solid #2a3a48;border-radius:14px;font:13px/1.4 system-ui,Segoe UI,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.5)}
  #tsp.min{max-height:none}
  #tsp .hd{display:flex;align-items:center;gap:8px;padding:11px 13px;background:#6c4bb0;border-radius:14px 14px 0 0}
  #tsp .hd b{font-size:14px;flex:1}
  #tsp .hd .x{cursor:pointer;font-size:16px;opacity:.9}
  #tsp .bd{padding:12px 13px;overflow:auto} #tsp.min .bd{display:none}
  #tsp button{border:0;border-radius:10px;font-weight:800;color:#fff;cursor:pointer;font-family:inherit;font-size:13px}
  #tsp .build{background:#22303c;padding:12px 8px;width:100%;margin-bottom:8px}
  #tsp .st{margin:6px 0 8px;color:#9fb4c6;font-size:12px;min-height:16px}
  #tsp .grp{display:flex;align-items:center;gap:8px;background:#101923;border:1px solid #26333f;border-radius:10px;padding:9px 10px;margin-bottom:7px}
  #tsp .grp .t{flex:1;font-weight:700} #tsp .grp .n{color:#8fd3ef;font-weight:800}
  #tsp .grp button{background:#22303c;padding:7px 9px;font-size:11px}
  #tsp .grp button.rz{background:#c0392b}
  #tsp .grp.no .n{color:#ffcf8f}
  #tsp .bk{display:flex;justify-content:space-between;font-size:12px;color:#cfe1ef;padding:3px 4px;border-bottom:1px solid #1c2731}
  #tsp .bk .v{color:#8fd3ef;font-weight:800}
  #tsp ul{list-style:none;margin:6px 0 0;padding:0;max-height:34vh;overflow:auto}
  #tsp li{display:flex;gap:8px;font-size:12px;padding:4px 4px;border-bottom:1px solid #1c2731}
  #tsp li .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #tsp li .tg{color:#9fb4c6;flex-shrink:0}
  #tsp .sec{margin-top:8px}
  `;
  document.documentElement.appendChild(style);
  const panel = document.createElement('div'); panel.id = 'tsp'; document.body.appendChild(panel);

  function listHtml(rows, withTag) {
    return `<ul>${rows.map((r) => `<li${r.done ? ' style="opacity:.5"' : ''}><span class="nm">${esc(r.name)}${r.done ? ' ✓' : ''}${r.failed ? ' ✗' : ''}</span>${withTag ? `<span class="tg">${esc(LABELS[r.bucket] || '')}</span>` : ''}<span class="tg">${esc(r.phone)}</span></li>`).join('')}</ul>`;
  }

  function render() {
    const bd = ['sodPrice', 'sodNo', 'dollar', 'leaf', 'other'].filter((k) => counts[k]);
    panel.innerHTML = `
      <div class="hd"><b>🔀 Texted Split</b><span class="x" id="tsmin">–</span></div>
      <div class="bd">
        <button class="build" id="tsbuild">BUILD</button>
        <div class="st">${esc(statusMsg)}</div>
        ${(texted.length || notTexted.length) ? `
          <div class="grp"><span class="t">✅ Have a texted note</span><span class="n">${texted.length}</span>
            <button data-c="texted">Copy</button><button data-l="texted">View</button><button class="rz" data-r="texted">${working ? 'STOP' : 'Resolve'}</button></div>
          ${bd.length ? `<div class="sec">${bd.map((k) => `<div class="bk"><span>${LABELS[k]}</span><span class="v">${counts[k]}</span></div>`).join('')}</div>` : ''}
          ${openList === 'texted' ? listHtml(texted, true) : ''}
          <div class="grp no" style="margin-top:9px"><span class="t">⬜ No texted note</span><span class="n">${notTexted.length}</span>
            <button data-c="not">Copy</button><button data-l="not">View</button></div>
          ${openList === 'not' ? listHtml(notTexted, false) : ''}
        ` : ''}
      </div>`;
    panel.querySelector('#tsmin').onclick = () => panel.classList.toggle('min');
    panel.querySelector('#tsbuild').onclick = build;
    panel.querySelectorAll('button[data-c]').forEach((b) => { b.onclick = () => { const g = b.dataset.c; g === 'texted' ? copyList(texted, 'Have a texted note') : copyList(notTexted, 'No texted note'); }; });
    panel.querySelectorAll('button[data-l]').forEach((b) => { b.onclick = () => { const g = b.dataset.l; openList = (openList === g) ? '' : g; render(); }; });
    const rz = panel.querySelector('button[data-r]'); if (rz) rz.onclick = resolveTexted;
  }
  render();
})();
