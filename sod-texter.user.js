// ==UserScript==
// @name         Bosco Sod Texter
// @namespace    local.sa.sodtexter
// @version      1.0
// @updateURL    https://raw.githubusercontent.com/lwilliams027/bosco-aircall-dialer/main/sod-texter.user.js
// @downloadURL  https://raw.githubusercontent.com/lwilliams027/bosco-aircall-dialer/main/sod-texter.user.js
// @description  A/B sod webworm text campaign through the Aircall bridge. Scans every Tech Note, detects sod webworm (skips anyone already on surface insecticide), splits 50/50 price vs no-price balanced by note count, previews, then sends. Permanent ledger prevents double-texting.
// @match        https://bosco.serviceassistant.com/*
// @run-at       document-idle
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @connect      127.0.0.1
// ==/UserScript==

(function () {
  'use strict';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ========================= history scanner (own pending/result keys) =========================
  // Runs in the background tab we open for each lead. Detects sod webworm in the last 30 days,
  // whether they already have a surface insecticide, and the lawn size.
  const histM = location.pathname.match(/\/customer\/index\/(\d+)/i);
  if (histM) {
    (async function scan(acct) {
      let pend = 0; try { pend = GM_getValue('sx_pending_' + acct, 0); } catch (e) {}
      if (!pend || Date.now() - pend > 90000) return;                 // only when WE opened it
      try { GM_setValue('sx_pending_' + acct, 0); } catch (e) {}
      const NOW = Date.now(), THIRTY = 30 * 864e5;
      const rowDate = (r) => { const m = (r.innerText || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? new Date(+m[3], +m[1] - 1, +m[2]).getTime() : null; };
      const t0 = Date.now();
      while (Date.now() - t0 < 15000 && document.querySelectorAll('tr.dx-data-row').length === 0) await sleep(400);
      const rows = Array.from(document.querySelectorAll('tr.dx-data-row')).filter((r) => /\bL0[1-9]\b/i.test(r.innerText || ''));
      let sod = 0;
      for (const r of rows) {
        const d = rowDate(r);
        if (d && (NOW - d) > THIRTY) continue;                        // sod flag = last 30 days only
        r.click(); await sleep(700);
        if (/sod\s*webworm/i.test(document.body.innerText || '')) sod = 1;
      }
      // customer details tab -> existing treatments + size
      try {
        const cd = Array.from(document.querySelectorAll('a, button, [role="tab"]')).find((el) => (el.textContent || '').trim().toLowerCase() === 'customer details')
                || Array.from(document.querySelectorAll('li, span, div')).find((el) => el.children.length === 0 && (el.textContent || '').trim().toLowerCase() === 'customer details');
        if (cd) (cd.closest('a, button, li, [role="tab"]') || cd).click();
        const t1 = Date.now();
        while (Date.now() - t1 < 8000 && !document.querySelector('a[href*="/Customer/Program/Index/"]')) await sleep(300);
        await sleep(400);
      } catch (e) {}
      const svc = (document.body.innerText || '').toLowerCase();
      const hasSodTx = /surface insecticide|grub killer|dylox|\binsecticide\b/.test(svc) ? 1 : 0;
      let size = ''; try { const mm = ((document.querySelector('#DetailProperty') || document.body).innerText || '').match(/(\d+(?:\.\d+)?)\s*1000\s*sq\s*ft/i); if (mm) size = String(parseInt(mm[1], 10)); } catch (e) {}
      console.log('[sx-scan]', acct, 'sod=' + sod, 'hasTx=' + hasSodTx, 'size=' + size);
      try { GM_setValue('sx_condition', { acct: String(acct), sod: sod, hasSodTx: hasSodTx, size: size, ts: Date.now() }); } catch (e) {}
    })(histM[1]);
    return;
  }

  // only build the panel on the call log
  if (!/CallLog/i.test(location.href)) return;

  // ========================= helpers =========================
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = (d) => (d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : d);
  const firstName = (n) => (String(n || '').trim().split(/\s+/)[0] || 'there').replace(/[^A-Za-z'-]/g, '') || 'there';
  const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

  const BRIDGE = 'http://127.0.0.1:8123';
  function bridge(path, method, body) {
    return new Promise((resolve) => {
      try { GM_xmlhttpRequest({ method: method || 'GET', url: BRIDGE + path, data: body || null, timeout: 15000,
        onload: (r) => resolve(r.responseText || ''), onerror: () => resolve(null), ontimeout: () => resolve(null) });
      } catch (e) { resolve(null); }
    });
  }

  const getRows = () => Array.from(document.querySelectorAll('div.callRow'));
  const getLabel = (row) => (row.dataset.callstatus || (row.querySelector('.callStatus .badge, .callStatus .text') || {}).textContent || '').trim();
  const isTech = (label) => label.toLowerCase().includes('tech note');
  const realNotes = () => Array.from(document.querySelectorAll('div.note.container')).filter((n) => n.id !== 'NewNote' && !n.classList.contains('add-note') && !n.classList.contains('system') && n.offsetParent !== null);
  const noteCount = () => realNotes().length;
  const notesSig = () => realNotes().map((n) => n.id).join(',');
  const openLead = (row) => (row.querySelector('.stronger') || row.querySelector('.listView') || row).click();
  const leadInfo = (row) => { const digits = (row.dataset.customerphone || '').replace(/\D/g, ''); return { acct: row.dataset.accountnumber || '', name: row.dataset.customername || '(lead)', phone: fmt(digits), e164: '+1' + digits }; };
  async function waitForLoad(prevSig) { const start = performance.now(); while (performance.now() - start < 2000) { await sleep(120); if (notesSig() !== prevSig) { await sleep(300); return true; } } return false; }
  function scrollContainer() { const r = document.querySelector('div.callRow'); if (!r) return null; let el = r.parentElement; while (el && el !== document.body) { const s = getComputedStyle(el); if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 5) return el; el = el.parentElement; } return null; }

  // Surface Insect / Grub Killer: $145 base (<=5k), +$18 per 1k over 5
  function surfacePrice(size) { const z = parseFloat(size) || 0; const p = z <= 5 ? 145 : 145 + (z - 5) * 18; return '$' + Math.round(p); }
  const sizeKnown = (size) => !!(parseFloat(size));

  // ========================= the two prompts =========================
  const MSG_PRICE = (n, price) => `Hey ${n} this is Landon with Lush Lawn Safari Tree, you had a technician out the other day and he just wanted me to send you a text to let you know he did a good job on the application and you should start seeing some results pretty quickly! He also wanted me to let you know he found an insect called sod webworm. Basically they are a surface feeding insect that eats your grass. The problem is, now that they're in your lawn they will continue to feed on your grass, potentially killing off sections of the lawn causing you to repair and reseed those areas. So what we do is put down an insecticide called Dylox, which will kill the sod webworm and stop them from doing any further damage and its guaranteed. I just wanted to make sure its okay to do for you before any further damage was done! Its one treatment for ${price} guaranteeing your lawn is protected for 60 days! I'll shoot you a call to address this issue in a few but if you would like me to go forward with this for you right now let me know!`;
  const MSG_NOPRICE = (n) => `Hey ${n} this is Landon with Lush Lawn Safari Tree, you had a technician out the other day and he just wanted me to send you a text to let you know he did a good job on the application and you should start seeing some results pretty quickly! He also wanted me to let you know he found an insect called sod webworm. Basically they are a surface feeding insect that eats your grass. The problem is, now that they're in your lawn they will continue to feed on your grass, potentially killing off sections of the lawn causing you to repair and reseed those areas. So what we do is put down an insecticide called Dylox, which will kill the sod webworm and stop them from doing any further damage and its guaranteed. I just wanted to make sure its okay to do for you before any further damage was done! I'll shoot you a call to address this issue in a few but if you would like me to go forward with this for you right now let me know!`;

  // ========================= permanent do-not-double-text ledger =========================
  const LEDGER_KEY = 'sx_texted';                                     // { acct: {name, when, prompt} }
  let ledger = {}; try { ledger = GM_getValue(LEDGER_KEY, {}) || {}; } catch (e) { ledger = {}; }
  const alreadyTexted = (acct) => Object.prototype.hasOwnProperty.call(ledger, acct);
  function recordTexted(lead, prompt) { ledger[lead.acct] = { name: lead.name, when: Date.now(), prompt }; try { GM_setValue(LEDGER_KEY, ledger); } catch (e) {} }

  // ========================= state =========================
  let scanning = false, sending = false, plan = [], skippedTexted = 0, scanned = 0;

  function lookupSod(acct) {
    return new Promise((resolve) => {
      let done = false, lid = null, tab = null;
      const finish = (v) => { if (done) return; done = true; try { if (lid != null) GM_removeValueChangeListener(lid); } catch (e) {} try { if (tab && tab.close) tab.close(); } catch (e) {} resolve(v); };
      try { lid = GM_addValueChangeListener('sx_condition', (n, o, v) => { if (v && String(v.acct) === String(acct)) finish(v); }); } catch (e) {}
      try { GM_setValue('sx_pending_' + acct, Date.now()); } catch (e) {}
      try { tab = GM_openInTab(`https://bosco.serviceassistant.com/172154/Customer/customer/index/${acct}/history`, { active: false, insert: true }); } catch (e) {}
      setTimeout(() => finish({ sod: 0, hasSodTx: 0, size: '' }), 35000);
    });
  }

  // ========================= scan all tech notes =========================
  async function runScan() {
    if (scanning) { scanning = false; return; }                      // second click = stop
    if (sending) return;
    scanning = true; plan = []; skippedTexted = 0; scanned = 0;
    const qualifying = [], seen = new Set();
    setStatus('Scanning tech notes…'); render();
    const sc = scrollContainer(); let idle = 0;
    while (scanning) {
      let didNew = false;
      for (const row of getRows()) {
        if (!scanning) break;
        const label = getLabel(row);
        const info = leadInfo(row);
        if (!info.acct || seen.has(info.acct)) continue;
        seen.add(info.acct); didNew = true;
        if (!isTech(label)) continue;                                 // tech notes only
        if (alreadyTexted(info.acct)) { skippedTexted++; render(); continue; }
        // note count from the call log
        const prev = notesSig(); openLead(row); await waitForLoad(prev);
        const nc = noteCount();
        scanned++; setStatus(`Scanning… ${scanned} checked, ${qualifying.length} sod so far`); render();
        // condition lookup in a background tab
        const c = await lookupSod(info.acct);
        if (c.sod && !c.hasSodTx) qualifying.push({ ...info, noteCount: nc, size: c.size || '' });
        await sleep(60);
      }
      const before = getRows().length;
      if (sc) sc.scrollTop = sc.scrollHeight; else { const rs = getRows(); if (rs.length) rs[rs.length - 1].scrollIntoView({ block: 'end' }); }
      await sleep(800);
      if (!didNew && getRows().length <= before) { idle++; if (idle >= 2) break; } else idle = 0;
    }
    scanning = false;
    plan = buildPlan(qualifying);
    setStatus(plan.length ? `Ready — ${plan.length} to text (${skippedTexted} skipped, already texted)` : `No un-texted sod webworm tech notes found (${skippedTexted} already texted).`);
    render();
  }

  // ========================= 50/50 split, balanced by note count =========================
  function buildPlan(leads) {
    const one = shuffle(leads.filter((l) => l.noteCount === 1));
    const multi = shuffle(leads.filter((l) => l.noteCount !== 1));
    const price = [], noprice = [];
    one.forEach((l, i) => (i % 2 === 0 ? price : noprice).push(l));       // one-note split 50/50
    multi.forEach((l, i) => (i % 2 === 0 ? noprice : price).push(l));     // multi split 50/50, offset so totals stay even
    const out = [];
    price.forEach((l) => out.push({ lead: l, withPrice: true, group: l.noteCount === 1 ? '1-note' : 'multi', message: MSG_PRICE(firstName(l.name), surfacePrice(l.size)), sizeOk: sizeKnown(l.size) }));
    noprice.forEach((l) => out.push({ lead: l, withPrice: false, group: l.noteCount === 1 ? '1-note' : 'multi', message: MSG_NOPRICE(firstName(l.name)), sizeOk: true }));
    return out;
  }

  // ========================= send =========================
  async function sendAll() {
    if (sending || scanning || !plan.length) return;
    const todo = plan.filter((p) => !alreadyTexted(p.lead.acct));
    if (!todo.length) { setStatus('Everyone in this plan has already been texted.'); render(); return; }
    const ping = await bridge('/state', 'GET');
    if (ping == null) { alert('Bridge not reachable.\nStart the dialer bridge (start-dialer.bat) and make sure Aircall is logged in, then try again.'); return; }
    if (!confirm(`Send ${todo.length} live texts now?\n\nPrice prompt: ${todo.filter((p) => p.withPrice).length}\nNo-price prompt: ${todo.filter((p) => !p.withPrice).length}\n\nEach person is recorded so they can't be texted again.`)) return;
    sending = true; let sent = 0, failed = 0;
    for (const item of todo) {
      if (!sending) break;
      if (alreadyTexted(item.lead.acct)) continue;                    // final guard
      setStatus(`Sending ${sent + 1}/${todo.length} — ${item.lead.name}…`); render();
      const resp = await bridge('/text', 'POST', JSON.stringify({ number: item.lead.e164, message: item.message }));
      const ok = resp != null && !/error|bad number|not found|fail/i.test(resp);
      if (ok) { recordTexted(item.lead, item.withPrice ? 'price' : 'noprice'); sent++; }
      else { failed++; console.warn('[sx-send] failed', item.lead.acct, resp); }
      item.sent = ok; item.failed = !ok;
      render();
      await sleep(3000);
    }
    sending = false;
    setStatus(`Done — ${sent} sent${failed ? `, ${failed} failed (check the bridge window)` : ''}. Ledger: ${Object.keys(ledger).length} total.`);
    render();
  }

  // ========================= panel =========================
  const style = document.createElement('style');
  style.textContent = `
  #sxp{position:fixed;left:14px;bottom:14px;z-index:2147483000;width:340px;max-height:78vh;display:flex;flex-direction:column;
    background:#141d27;color:#e8eef4;border:1px solid #2a3a48;border-radius:14px;font:13px/1.4 system-ui,Segoe UI,sans-serif;
    box-shadow:0 12px 40px rgba(0,0,0,.5)}
  #sxp.min{max-height:none}
  #sxp .hd{display:flex;align-items:center;gap:8px;padding:11px 13px;background:#0f94d2;border-radius:14px 14px 0 0;cursor:default}
  #sxp .hd b{font-size:14px;letter-spacing:.3px;flex:1}
  #sxp .hd .x{cursor:pointer;font-size:16px;opacity:.9}
  #sxp .bd{padding:12px 13px;overflow:auto}
  #sxp.min .bd{display:none}
  #sxp .row{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  #sxp button{border:0;border-radius:10px;font-weight:800;color:#fff;cursor:pointer;font-family:inherit;padding:12px 8px;font-size:13px}
  #sxp .scan{background:#22303c} #sxp .scan.on{background:#f39c12;color:#3a2600}
  #sxp .send{background:#7BBF43;color:#08320f;width:100%;margin-top:9px;padding:15px}
  #sxp .send:disabled{opacity:.4;cursor:default}
  #sxp .st{margin:10px 0;color:#9fb4c6;font-size:12px;min-height:16px}
  #sxp .sum{display:flex;gap:6px;flex-wrap:wrap;margin:2px 0 8px}
  #sxp .tag{background:#1d2a36;border:1px solid #2c3e4d;border-radius:8px;padding:4px 8px;font-size:11px;font-weight:700;color:#cfe1ef}
  #sxp .tag.p{color:#8fd3ef} #sxp .tag.n{color:#ffcf8f}
  #sxp ul{list-style:none;margin:8px 0 0;padding:0}
  #sxp li{border:1px solid #26333f;border-radius:9px;padding:8px 9px;margin-bottom:6px;background:#101923}
  #sxp li.sent{border-color:#3a6b2a;background:#12240f} #sxp li.failed{border-color:#7a2a2a;background:#241010}
  #sxp .ln{font-weight:700;display:flex;align-items:center;gap:6px}
  #sxp .ln .pr{margin-left:auto;font-size:10px;font-weight:800;padding:2px 7px;border-radius:6px}
  #sxp .pr.p{background:#123a4d;color:#8fd3ef} #sxp .pr.n{background:#3a3112;color:#ffcf8f}
  #sxp .meta{color:#8ea3b5;font-size:11px;margin-top:2px}
  #sxp .meta .g{color:#7BBF43;font-weight:700} #sxp .meta .warn{color:#ffb3ab;font-weight:700}
  #sxp .msg{display:none;margin-top:6px;padding:7px;background:#0b1219;border:1px solid #223140;border-radius:7px;font-size:11.5px;color:#c7d6e3;white-space:pre-wrap}
  #sxp li.open .msg{display:block}
  #sxp .foot{display:flex;gap:6px;margin-top:10px;align-items:center}
  #sxp .foot .lg{color:#8ea3b5;font-size:11px;flex:1}
  #sxp .foot button{padding:8px 9px;font-size:11px;background:#22303c}
  #sxp .foot button.clr{background:#33212a;color:#ffb3ab}
  `;
  document.documentElement.appendChild(style);

  const panel = document.createElement('div');
  panel.id = 'sxp';
  document.body.appendChild(panel);
  let statusMsg = 'Scan your tech notes to build the sod webworm list.';
  const setStatus = (s) => { statusMsg = s; };

  function render() {
    const priceN = plan.filter((p) => p.withPrice).length, noN = plan.length - priceN;
    const one = plan.filter((p) => p.group === '1-note').length, multi = plan.length - one;
    panel.innerHTML = `
      <div class="hd"><b>🐛 Sod Texter</b><span class="x" id="sxmin">–</span></div>
      <div class="bd">
        <div class="row">
          <button class="scan ${scanning ? 'on' : ''}" id="sxscan">${scanning ? 'STOP SCAN' : 'SCAN TECH NOTES'}</button>
          <button class="scan" id="sxrescan" ${scanning || sending ? 'disabled' : ''}>RESET LIST</button>
        </div>
        <div class="st">${esc(statusMsg)}</div>
        ${plan.length ? `<div class="sum">
          <span class="tag">${plan.length} total</span>
          <span class="tag p">💲 ${priceN} price</span>
          <span class="tag n">no-price ${noN}</span>
          <span class="tag">1-note ${one}</span>
          <span class="tag">multi ${multi}</span>
        </div>` : ''}
        <button class="send" id="sxsend" ${(!plan.length || sending || scanning) ? 'disabled' : ''}>${sending ? 'SENDING…' : `SEND ALL (${plan.filter((p) => !alreadyTexted(p.lead.acct)).length})`}</button>
        <ul id="sxlist">
          ${plan.map((p, i) => `
            <li data-i="${i}" class="${p.sent ? 'sent' : ''}${p.failed ? ' failed' : ''}">
              <div class="ln">${esc(p.lead.name)}
                <span class="pr ${p.withPrice ? 'p' : 'n'}">${p.withPrice ? 'PRICE' : 'NO PRICE'}</span></div>
              <div class="meta">${esc(p.lead.phone)} · <span class="g">${p.group}</span>${p.withPrice ? ` · ${esc(surfacePrice(p.lead.size))}${p.sizeOk ? '' : ' <span class="warn">⚠ size?</span>'}` : ''}${p.sent ? ' · <span class="g">sent ✓</span>' : ''}${p.failed ? ' · <span class="warn">failed</span>' : ''}</div>
              <div class="msg">${esc(p.message)}</div>
            </li>`).join('')}
        </ul>
        <div class="foot">
          <span class="lg">Ledger: ${Object.keys(ledger).length} texted</span>
          <button id="sxcopy">Copy ledger</button>
          <button class="clr" id="sxclear">Reset ledger</button>
        </div>
      </div>`;
    panel.querySelector('#sxmin').onclick = () => panel.classList.toggle('min');
    panel.querySelector('#sxscan').onclick = runScan;
    panel.querySelector('#sxrescan').onclick = () => { plan = []; setStatus('List cleared. Scan again to rebuild.'); render(); };
    panel.querySelector('#sxsend').onclick = sendAll;
    panel.querySelector('#sxcopy').onclick = () => { try { GM_setClipboard(JSON.stringify(ledger, null, 2)); setStatus('Ledger copied to clipboard.'); render(); } catch (e) {} };
    panel.querySelector('#sxclear').onclick = () => {
      if (!confirm(`Reset the do-not-text ledger?\n\nThis erases the record of ${Object.keys(ledger).length} texted people — they could be texted again. This cannot be undone.`)) return;
      if (!confirm('Are you absolutely sure? Type-of-thing you only do to start a brand new campaign.')) return;
      ledger = {}; try { GM_setValue(LEDGER_KEY, ledger); } catch (e) {} setStatus('Ledger cleared.'); render();
    };
    panel.querySelectorAll('#sxlist li').forEach((li) => { li.querySelector('.ln').onclick = () => li.classList.toggle('open'); });
  }
  render();
})();
