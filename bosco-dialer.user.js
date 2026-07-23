// ==UserScript==
// @name         Bosco Dialer
// @namespace    local.sa.dialer
// @version      5.2
// @updateURL    https://raw.githubusercontent.com/lwilliams027/bosco-aircall-dialer/main/bosco-dialer.user.js
// @downloadURL  https://raw.githubusercontent.com/lwilliams027/bosco-aircall-dialer/main/bosco-dialer.user.js
// @description  Prioritized call queue via a local bridge: dial/hangup, global Up/Down, Esc pause (hang up)/resume (redial), no-answer condition lookup + auto note/resolve, phone control page.
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

  // ================= History condition scanner (runs on the customer history page) =================
  const histM = location.pathname.match(/\/customer\/index\/(\d+)/i);
  if (histM) {
    (async function scanCondition(acct) {
      // only run when WE opened this page for a lookup (not when the user manually browses a customer)
      let pend = 0; try { pend = GM_getValue('sa_pending_' + acct, 0); } catch (e) {}
      if (!pend || Date.now() - pend > 90000) return;
      try { GM_setValue('sa_pending_' + acct, 0); } catch (e) {}
      console.log('[sa-scan] history scanner for', acct);
      const NOW = Date.now(), THIRTY = 30 * 864e5; // last 30 days
      const rowDate = (r) => { const m = (r.innerText || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? new Date(+m[3], +m[1] - 1, +m[2]).getTime() : null; };
      const readConds = () => {
        const b = (document.body ? document.body.innerText || '' : '').toLowerCase(); const s = {};
        if (b.includes('moles')) s.moles = 1;
        if (b.includes('sod webworm')) s.sod = 1;
        if (b.includes('dollar spot') || b.includes('leaf spot')) s.disease = 1;
        return s;
      };
      const t0 = Date.now();
      while (Date.now() - t0 < 15000 && document.querySelectorAll('tr.dx-data-row').length === 0) await sleep(400);
      const grabTC = () => {
        const heads = Array.from(document.querySelectorAll('div,span,td,li,p,strong,b,h4,h5,label,th'));
        const el = heads.find((e) => /^\s*target\s*\/\s*conditions/i.test((e.textContent || '').trim()) && (e.textContent || '').trim().length < 40);
        if (!el) return '';
        const box = el.closest('.panel-body, .col-md-6, .col-xs-12') || el.parentElement || el;
        let full = (box.innerText || '');
        const i = full.search(/target\s*\/\s*conditions/i);            // start AT the conditions heading
        let txt = i >= 0 ? full.slice(i) : full;
        txt = txt.split(/\n\s*(?:note\b|full charge|previous balance|net amount|net balance|prepay|balance\b|remit|posted|invoice)/i)[0]; // stop before note/pricing
        return txt.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim().slice(0, 400);
      };
      const rows = Array.from(document.querySelectorAll('tr.dx-data-row')).filter((r) => /\bL0[1-9]\b/i.test(r.innerText || ''));
      const found = {}; const rawParts = [];
      for (const r of rows) {
        const d = rowDate(r);
        if (d && (NOW - d) > THIRTY) continue; // skip treatments older than 30 days
        r.click(); await sleep(800);
        const c = readConds(); Object.assign(found, c);
        const tc = grabTC();
        if (tc) { const low = tc.toLowerCase(); if (low.includes('moles')) found.moles = 1; if (low.includes('sod webworm')) found.sod = 1; if (low.includes('dollar spot') || low.includes('leaf spot')) found.disease = 1; rawParts.push((d ? new Date(d).toLocaleDateString() : '?') + ' — ' + tc); }
        console.log('[sa-scan] row', d ? new Date(d).toLocaleDateString() : '?', '->', (tc || '').slice(0, 90));
      }
      console.log('[sa-scan] conditions(30d):', Object.keys(found).join(',') || 'none');
      // go to the Customer Details tab and wait for the Services panel to render
      try {
        const cd = Array.from(document.querySelectorAll('a, button, [role="tab"]')).find((el) => (el.textContent || '').trim().toLowerCase() === 'customer details')
                || Array.from(document.querySelectorAll('li, span, div')).find((el) => el.children.length === 0 && (el.textContent || '').trim().toLowerCase() === 'customer details');
        if (cd) (cd.closest('a, button, li, [role="tab"]') || cd).click();
        const t1 = Date.now();
        while (Date.now() - t1 < 8000 && !document.querySelector('a[href*="/Customer/Program/Index/"]')) await sleep(300);
        await sleep(500);
      } catch (e) {}
      const svc = (document.body.innerText || '').toLowerCase();
      const hasTx = {
        moles: /mole/.test(svc),
        sod: /surface insecticide|insecticide/.test(svc),
        disease: /lawn disease|disease control|disease treatment|(?:prevent|curat)\w*\s*\w*\s*disease|disease\s*\w*\s*(?:prevent|curat)/.test(svc),
      };
      // service/treatment list (LC, GP, ...) from #DetailServices, property size from #DetailProperty
      let services = []; try { services = [...new Set(Array.from(document.querySelectorAll('a[href*="/Customer/Program/Index/"]')).map((a) => (a.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean))]; } catch (e) {}
      let size = ''; try { const mm = ((document.querySelector('#DetailProperty') || document.body).innerText || '').match(/(\d+(?:\.\d+)?)\s*1000\s*sq\s*ft/i); if (mm) size = String(parseInt(mm[1], 10)); } catch (e) {}
      console.log('[sa-scan] hasTreatment:', JSON.stringify(hasTx), '| size', size, '| services', services);
      // priority moles > sod webworm > disease; skip a condition if they already have its treatment
      let best = 'none';
      if (found.moles && !hasTx.moles) best = 'moles';             // moles = leave alone (no text)
      else if (found.sod && !hasTx.sod) best = 'sod webworm';      // insect text
      else if (found.disease && !hasTx.disease) best = 'leaf spot'; // disease text
      const raw = best === 'none' ? rawParts.join('\n').slice(0, 1600) : '';
      console.log('[sa-scan] result:', best);
      try { GM_setValue('sa_condition', { acct: String(acct), condition: best, size, services, raw: raw, ts: Date.now() }); } catch (e) {}
    })(histM[1]);
    return; // don't run the call-queue UI on the customer/history page
  }

  // ================= config =================
  const BRIDGE = 'http://127.0.0.1:8123';
  const SEND_TEXTS = false; // texting removed for now
  const CALLABLE = [
    { type: 'tech', rank: 0, test: (s) => s.includes('tech note') },
    { type: 'cxl',  rank: 1, test: (s) => s.includes('cxl customer c/b') || (s.includes('cxl') && s.includes('c/b')) },
  ];
  const NO_ANSWER_NOTE = 'No Answer, Left Voicemail';
  const LOAD_TIMEOUT = 2000;
  const insectMsg = (n) => `Hey ${n}, this is Landon with Lush Lawn. We recently serviced your lawn. During that visit, our technician observed signs of insect activity that is causing damage to your turf. We wanted to make you aware of this issue as soon as possible. Based on the technician's assessment, we strongly recommend applying a surface insecticide treatment to help protect and restore the health of your lawn. Would you like a quote on this?`;
  const diseaseMsg = (n) => `Hey ${n}, this is Landon with Lush Lawn. We recently serviced your lawn. During that visit, our technician observed a lawn disease that is causing damage to your turf. We wanted to make you aware of this issue as soon as possible. Based on the technician's assessment, we strongly recommend applying a lawn disease treatment to help protect and restore the health of your lawn. Would you like a quote on this?`;

  const SCAN_KEY = 'f', START_KEY = 'Enter', ANSWER_KEY = 'ArrowUp', NOANS_KEY = 'ArrowDown', COPY_KEY = 's', CLEAR_KEY = 'c', PAUSE_KEY = 'Escape';

  let running = false, paused = false;
  const callQueue = [], others = [], seenAccts = new Set(), dialed = new Set();
  let callState = 'idle', currentLead = null, busy = false;
  let expandedAcct = null, panelMin = false;

  const fmt = (d) => (d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : d);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const firstName = (n) => (String(n || '').trim().split(/\s+/)[0] || 'there').replace(/[^A-Za-z'-]/g, '') || 'there';

  function bridge(path, method, body) {
    return new Promise((resolve) => {
      try { GM_xmlhttpRequest({ method: method || 'GET', url: BRIDGE + path, data: body || null, timeout: 6000,
        onload: (r) => resolve(r.responseText || ''), onerror: () => resolve(null), ontimeout: () => resolve(null) });
      } catch (e) { resolve(null); }
    });
  }
  const bridgeDial = (num) => bridge('/dial', 'POST', num);
  const bridgeHangup = () => bridge('/hangup', 'POST');

  function setNative(el, val) {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function nextBusinessDay() { const d = new Date(); d.setHours(0, 0, 0, 0); do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6); return d; }
  const fmtDue = (d) => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}, 12:00 AM`;

  const getRows = () => Array.from(document.querySelectorAll('div.callRow'));
  const getLabel = (row) => (row.dataset.callstatus || (row.querySelector('.callStatus .badge, .callStatus .text') || {}).textContent || '').trim();
  const classify = (label) => CALLABLE.find((c) => c.test(label.toLowerCase())) || null;
  const realNotes = () => Array.from(document.querySelectorAll('div.note.container')).filter((n) => n.id !== 'NewNote' && !n.classList.contains('add-note') && !n.classList.contains('system') && n.offsetParent !== null);
  const noteCount = () => realNotes().length;
  const notesSig = () => realNotes().map((n) => n.id).join(',');
  function scrapeNotesList() {
    return realNotes().map((n) => {
      const who = ((n.querySelector('.assigneeImage [data-original-title]') || {}).getAttribute && n.querySelector('.assigneeImage [data-original-title]').getAttribute('data-original-title')) || ((n.querySelector('.empInitials') || {}).textContent || '').trim();
      const when = ((n.querySelector('.note-time') || {}).textContent || '').trim();
      const outcome = ((n.querySelector('.note-topic') || {}).textContent || '').trim();
      let body = '';
      n.querySelectorAll('.noteText .col-xs-12').forEach((c) => { if (c.classList.contains('outcome') || c.classList.contains('emailNote')) return; const t = c.textContent.trim(); if (t) body += (body ? ' ' : '') + t; });
      return { who: who || '', when: when || '', text: (outcome ? outcome + (body ? ': ' + body : '') : body) };
    });
  }
  function openLead(row) { (row.querySelector('.stronger') || row.querySelector('.listView') || row).click(); }
  async function waitForLoad(prevSig) { const start = performance.now(); while (performance.now() - start < LOAD_TIMEOUT) { await sleep(120); if (notesSig() !== prevSig) { await sleep(300); return true; } } return false; }
  function leadInfo(row) { const digits = (row.dataset.customerphone || '').replace(/\D/g, ''); return { acct: row.dataset.accountnumber || '', name: row.dataset.customername || '(lead)', phone: fmt(digits), e164: '+1' + digits, row }; }
  function issueRank(l) { const i = typeof l.issue === 'string' ? l.issue : ''; if (i === 'moles') return 0; if (i === 'sod webworm') return 1; if (i === 'leaf spot' || i === 'dollar spot') return 2; return 3; }
  function sortedQueue() { return callQueue.slice().sort((a, b) => { const ai = issueRank(a), bi = issueRank(b); if (ai !== bi) return ai - bi; const an = a.noteCount === 1 ? 0 : 1, bn = b.noteCount === 1 ? 0 : 1; if (an !== bn) return an - bn; return CALLABLE.find((c) => c.type === a.type).rank - CALLABLE.find((c) => c.type === b.type).rank; }); }
  const nextUndialed = () => sortedQueue().find((l) => !dialed.has(l.acct));

  // ---- persistence: save the queue and reload it on startup instead of re-scanning ----
  const STORE_KEY = 'sa_queue';
  const STALE_MS = 20 * 3600e3;
  let saveTimer = null;
  function saveState() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; try { GM_setValue(STORE_KEY, { q: callQueue.map(({ row, ...r }) => r), o: others.map(({ row, ...r }) => r), d: Array.from(dialed), ts: Date.now() }); } catch (e) {} }, 1200);
  }
  function loadState() {
    try {
      const st = GM_getValue(STORE_KEY, null);
      if (!st || !st.q || !st.q.length || (Date.now() - (st.ts || 0)) > STALE_MS) return false;
      callQueue.length = 0; others.length = 0; dialed.clear(); seenAccts.clear();
      st.q.forEach((r) => { const l = { ...r, row: null }; if (l.issue === null) delete l.issue; callQueue.push(l); seenAccts.add(r.acct); });
      (st.o || []).forEach((r) => { others.push({ ...r, row: null }); seenAccts.add(r.acct); });
      (st.d || []).forEach((a) => dialed.add(a));
      return true;
    } catch (e) { return false; }
  }
  // find a lead's row in the current DOM (scroll to load it if virtualized away)
  async function resolveRow(lead) {
    if (lead.row && document.body.contains(lead.row) && lead.row.dataset.accountnumber === lead.acct) return lead.row;
    let el = document.querySelector(`div.callRow[data-accountnumber="${lead.acct}"]`);
    if (el) { lead.row = el; return el; }
    const sc = scrollContainer();
    if (sc) {
      sc.scrollTop = 0; await sleep(300);
      for (let i = 0; i < 80; i++) {
        el = document.querySelector(`div.callRow[data-accountnumber="${lead.acct}"]`);
        if (el) { lead.row = el; el.scrollIntoView({ block: 'center' }); await sleep(200); return el; }
        const before = sc.scrollTop; sc.scrollTop = Math.min(sc.scrollTop + sc.clientHeight * 0.85, sc.scrollHeight);
        await sleep(250);
        if (sc.scrollTop <= before + 2) break;
      }
    }
    return null;
  }
  function scrollContainer() {
    const r = document.querySelector('div.callRow'); if (!r) return null;
    let el = r.parentElement;
    while (el && el !== document.body) { const s = getComputedStyle(el); if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 5) return el; el = el.parentElement; }
    return null;
  }
  async function scan() {
    if (running) { running = false; return; }
    running = true;
    const issueMap = {}; callQueue.forEach((l) => { if (l.issue !== undefined) issueMap[l.acct] = l.issue; });
    callQueue.length = 0; others.length = 0; seenAccts.clear();   // fresh rebuild (keep dialed)
    const sc = scrollContainer();
    let idle = 0;
    while (running) {                                  // keep scrolling until no new leads load (no 50 cap)
      let didNew = false;
      for (const row of getRows()) {
        if (!running) break;
        const acct = row.dataset.accountnumber || ''; if (seenAccts.has(acct)) continue;
        didNew = true;
        const cat = classify(getLabel(row));
        if (!cat) { seenAccts.add(acct); others.push({ ...leadInfo(row), label: getLabel(row) }); renderPanel(); continue; }
        const prev = notesSig(); openLead(row); await waitForLoad(prev); seenAccts.add(acct);
        const lead = { ...leadInfo(row), label: getLabel(row), type: cat.type, noteCount: noteCount() };
        if (issueMap[acct] !== undefined) lead.issue = issueMap[acct];
        callQueue.push(lead);
        renderPanel(); badge(`Scanning — queue ${callQueue.length} · log ${others.length} · scanned ${seenAccts.size}`, '#7BBF43'); await sleep(70);
      }
      const before = getRows().length;
      if (sc) sc.scrollTop = sc.scrollHeight; else { const rs = getRows(); if (rs.length) rs[rs.length - 1].scrollIntoView({ block: 'end' }); }
      await sleep(800);
      if (!didNew && getRows().length <= before) { idle++; if (idle >= 2) break; } else idle = 0;
    }
    running = false; renderPanel();
    badge(`Scan done — ${callQueue.length} to call, ${others.length} in log.`, '#0E94D2');
    enrichIssues();
  }
  // pull each Tech lead's issue in the background so it shows in the queue before you call
  let enriching = false;
  async function enrichIssues() {
    if (enriching) return; enriching = true;
    for (;;) {
      const l = sortedQueue().find((x) => x.type === 'tech' && x.issue === undefined);
      if (!l) break;
      l.issue = null; renderPanel();
      const r = await lookupCondition(l.acct);
      l.issue = r.condition; l.size = r.size || ''; l.services = r.services || []; l.raw = r.raw || '';
      renderPanel();
    }
    enriching = false;
  }
  async function startLead(lead) {
    if (!lead) { callState = 'idle'; currentLead = null; renderPanel(); badge('Queue complete — every lead handled.', '#0E94D2'); return; }
    currentLead = lead;
    const row = await resolveRow(lead);
    if (!row) { badge(`Couldn't find ${lead.name} in the list — skipping`, '#c0392b'); dialed.add(lead.acct); return startLead(nextUndialed()); }
    const prev = notesSig(); openLead(row); await waitForLoad(prev);
    lead.noteCount = noteCount();   // refresh (notes may have changed since last scan)
    lead.notesList = scrapeNotesList();   // capture the account's notes for the control page
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    bridgeDial(lead.e164); callState = 'ringing'; renderPanel();
    badge(`RINGING ${lead.name} ${lead.phone} [${lead.type.toUpperCase()}] · ${lead.noteCount} note(s)\n▲ = answered   ▼ = no answer`, '#7BBF43');
  }
  function advance() { if (currentLead) dialed.add(currentLead.acct); callState = 'idle'; renderPanel(); startLead(nextUndialed()); }
  async function hangup() { await bridgeHangup(); await sleep(500); }
  let pendingRedial = false;
  function resumeFlow() {
    paused = false; renderPanel();
    if (pendingRedial && currentLead && !dialed.has(currentLead.acct)) { bridgeDial(currentLead.e164); callState = 'ringing'; badge(`Resumed — redialing ${currentLead.name}`, '#0E94D2'); }
    else badge('Resumed', '#0E94D2');
    pendingRedial = false;
  }
  function togglePause() {   // pause: hangs up, resume redials
    if (paused) { resumeFlow(); return; }
    paused = true; pendingRedial = true; renderPanel(); bridgeHangup();
    badge('PAUSED — call hung up. Esc to resume', '#f39c12');
  }
  function toggleHold() {    // "getting a call": pause but KEEP the call, no redial on resume
    if (paused) { resumeFlow(); return; }
    paused = true; pendingRedial = false; renderPanel();
    badge('ON HOLD — call kept. Resume when ready', '#f39c12');
  }

  async function onAnswerKey() {
    if (paused || busy) return;
    if (callState === 'ringing') { callState = 'answered'; renderPanel(); badge(`ON CALL ${currentLead.name}\n▲ = go next · R = resolve`, '#0E94D2'); }
    else if (callState === 'answered') { busy = true; await hangup(); busy = false; advance(); }   // go next
  }
  async function onResolve() {
    if (paused || busy || (callState !== 'ringing' && callState !== 'answered')) return;
    busy = true; const lead = currentLead;
    try { await hangup(); badge(`Resolving ${lead.name}…`, '#f39c12'); await addNoteAndSave(`Not interested in ${treatmentName(lead.issue)} - ${todayStr()}`); await resolveStatus(); lead.noteCount = noteCount(); }
    catch (e) { console.error('[resolve]', e); badge('Resolve error — F12', '#c0392b'); }
    busy = false; advance();
  }
  async function onNoAnswerKey() {
    if (paused || busy || (callState !== 'ringing' && callState !== 'answered')) return;
    busy = true; const lead = currentLead;
    try {
      await hangup();
      const count = noteCount();
      if (count <= 1) { badge(`No answer — logging…`, '#f39c12'); await noAnswerOneNote(); }
      else { badge(`Didn't answer twice — resolving…`, '#f39c12'); await noAnswerMultiNote(); }
      lead.noteCount = noteCount();   // reflect the note we just added
    } catch (e) { console.error('[no-answer]', e); badge('No-answer error — F12', '#c0392b'); }
    busy = false; advance();
  }
  async function doRun() { if (paused || running || callState !== 'idle') return; if (!callQueue.length) await scan(); if (nextUndialed()) startLead(nextUndialed()); else badge(`Nothing callable. ${others.length} in log.`, '#0E94D2'); }

  // ---- history condition lookup (opens the history page in a background tab) ----
  function lookupCondition(acct) {
    return new Promise((resolve) => {
      let done = false, lid = null, tab = null;
      const finish = (v) => { if (done) return; done = true; try { if (lid != null) GM_removeValueChangeListener(lid); } catch (e) {} try { if (tab && tab.close) tab.close(); } catch (e) {} resolve(v); };
      try { lid = GM_addValueChangeListener('sa_condition', (n, o, v) => { if (v && String(v.acct) === String(acct)) finish(v); }); } catch (e) {}
      try { GM_setValue('sa_pending_' + acct, Date.now()); } catch (e) {}   // authorize the scanner for this acct
      try { tab = GM_openInTab(`https://bosco.serviceassistant.com/172154/Customer/customer/index/${acct}/history`, { active: false, insert: true }); } catch (e) {}
      setTimeout(() => finish({ condition: 'none' }), 30000);
    });
  }
  async function sendText(lead, message, cond) {
    if (!SEND_TEXTS) { badge(`PREVIEW (${cond}) → ${lead.name}\n"${message.slice(0, 55)}…"\n[SEND_TEXTS is off]`, '#804000'); console.log('[text-preview]', cond, lead.e164, message); await sleep(600); return; }
    badge(`Texting ${lead.name} (${cond})…`, '#7BBF43');
    await bridge('/text', 'POST', JSON.stringify({ number: lead.e164, message }));
    await sleep(1800);
  }

  // ---- record edits ----
  function treatmentName(issue) {
    if (issue === 'sod webworm') return 'Surface Insecticide';
    if (issue === 'leaf spot' || issue === 'dollar spot') return 'Lawn Disease Treatment';
    if (issue === 'moles') return 'Mole Control';
    return 'the treatment';
  }
  const todayStr = () => { const d = new Date(); return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`; };
  async function addNoteAndSave(text) {
    if (!openNoteEditor()) { console.warn('[note] editor not opened'); return; }
    await sleep(500); const ta = findNoteTextarea();
    if (ta) setNative(ta, text); else console.warn('[note] textarea not found');
    await selectBlankOutcome();
    const save = document.querySelector('#SaveNewNote'); if (save) save.click(); else console.warn('[note] #SaveNewNote not found');
    await sleep(900);
  }
  async function resolveStatus() {
    const st = document.querySelector('#callStatus'); if (!st) { console.warn('[resolve] #callStatus not found'); return; }
    st.click(); await sleep(450); let done = false;
    const sel = document.querySelector('.editable-container select, .editableform select');
    if (sel) { const opt = Array.from(sel.options).find((o) => /^\s*resolved\s*$/i.test(o.text)); if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); done = true; } }
    if (!done) { const a = Array.from(document.querySelectorAll('.editable-container .dropdown-menu li a, .dropdown-menu.inner li a')).find((x) => /^\s*resolved\s*$/i.test(x.textContent)); if (a) { a.click(); done = true; } }
    await sleep(200); const chk = document.querySelector('.editable-submit, .editableform button[type=submit]');
    if (chk) chk.click(); else console.warn('[resolve] submit not found'); await sleep(700);
  }
  async function noAnswerOneNote() { await addNoteAndSave(NO_ANSWER_NOTE); await setDueNextBusinessDay(); }
  async function noAnswerMultiNote() { await addNoteAndSave("Didn't answer twice"); await resolveStatus(); }
  async function selectBlankOutcome() {
    const toggle = document.querySelector('button[data-id="ReasonID"]');
    const group = toggle ? toggle.closest('.bootstrap-select') : (document.querySelector('#ReasonID') ? document.querySelector('#ReasonID').closest('.bootstrap-select') : null);
    if (!group) { console.warn('[outcome] not found'); return; }
    const tg = group.querySelector('.dropdown-toggle') || toggle; if (tg) tg.click(); await sleep(180);
    const isBlank = (li) => ((li.querySelector('a') || {}).textContent || '').replace(/ /g, '').trim() === '';
    const items = Array.from(group.querySelectorAll('.dropdown-menu li'));
    const target = items.find((li) => !li.classList.contains('selected') && isBlank(li)) || items.find(isBlank);
    const a = target ? target.querySelector('a') : null;
    if (a) { a.click(); console.log('[outcome] set blank'); } else { console.warn('[outcome] blank not found'); if (tg) tg.click(); } await sleep(180);
  }
  function openNoteEditor() {
    let b = document.querySelector('a.action-new-note:not(.disabled)') || document.querySelector('a.action-new-note');
    if (!b) { const plus = document.querySelector('.panel-tools.message-actions .fa-plus, .message-actions .fa-plus'); b = plus ? plus.closest('a,button,li') : null; }
    if (b) { b.click(); return true; } return false;
  }
  function findNoteTextarea() { return Array.from(document.querySelectorAll('#callDetails textarea, .expandedView textarea, textarea.form-control')).find((t) => t.offsetParent !== null) || null; }
  async function setDueNextBusinessDay() {
    const val = fmtDue(nextBusinessDay());
    const due = Array.from(document.querySelectorAll('#callDetails input, .expandedView input')).find((inp) => /\d{1,2}\/\d{1,2}\/\d{4}/.test(inp.value || '') && !inp.readOnly);
    if (!due) { console.warn('[due] not found'); badge('Note saved. (Due not found — F12)', '#f39c12'); return; }
    setNative(due, val); due.dispatchEvent(new Event('blur', { bubbles: true })); console.log('[due] set ' + val);
  }

  // ---- panel / badge ----
  function ensurePanel() {
    let p = document.getElementById('sa-panel'); if (p) return p;
    p = document.createElement('div'); p.id = 'sa-panel';
    p.innerHTML = '<div class="sa-hd">Call Queue<span id="sa-x" style="float:right;cursor:pointer;margin-left:8px;">✕</span><span id="sa-min" style="float:right;cursor:pointer;font-size:16px;line-height:1;">–</span></div><div class="sa-body"></div>';
    document.body.appendChild(p);
    const style = document.createElement('style');
    style.textContent = `#sa-panel{position:fixed;top:56px;right:10px;width:250px;max-height:calc(100vh - 76px);z-index:2147483000;background:#fff;color:#222;border:1px solid #ccc;border-radius:10px;box-shadow:0 4px 18px rgba(0,0,0,.25);font:11px/1.35 system-ui,sans-serif;display:flex;flex-direction:column;overflow:hidden;}
      #sa-panel .sa-hd{background:#0E94D2;color:#fff;font-weight:700;padding:6px 10px;font-size:12px;} #sa-panel .sa-body{overflow:auto;padding:5px 8px 10px;}
      #sa-panel .sa-hint{color:#666;margin:3px 0 6px;font-size:10px;} #sa-panel .sa-sec{font-weight:700;margin:8px 0 3px;color:#0E94D2;border-top:1px solid #eee;padding-top:6px;}
      #sa-panel ol.sa-q{margin:0;padding-left:16px;} #sa-panel ol.sa-q li{margin:2px 0;padding:1px 0;} #sa-panel li.done{opacity:.4;text-decoration:line-through;} #sa-panel li.cur{background:#eaf5ff;border-radius:4px;font-weight:600;}
      #sa-panel .chip{display:inline-block;font-size:9px;font-weight:700;color:#fff;border-radius:3px;padding:1px 4px;margin-right:3px;} #sa-panel .chip.tech{background:#7BBF43;} #sa-panel .chip.cxl{background:#c0392b;}
      #sa-panel .sz{display:inline-block;background:#0E94D2;color:#fff;font-size:10px;font-weight:700;border-radius:3px;padding:0 4px;margin-right:4px;}
      #sa-panel .nm{cursor:pointer;} #sa-panel .nm:hover{text-decoration:underline;}
      #sa-panel .svc{margin:2px 0 4px 16px;padding:4px 6px;background:#f4f8fb;border:1px solid #dbe7f0;border-radius:4px;color:#333;}
      #sa-panel .ph{color:#0E94D2;} #sa-panel .nc{color:#888;font-size:10px;margin-left:4px;} #sa-panel .iss{color:#c0392b;font-weight:700;font-size:9px;margin-left:4px;text-transform:uppercase;} #sa-panel .glab{font-weight:600;margin:5px 0 2px;color:#804000;} #sa-panel .orow{color:#555;padding-left:6px;}`;
    document.head.appendChild(style);
    document.getElementById('sa-x').onclick = () => p.remove();
    document.getElementById('sa-min').onclick = () => { panelMin = !panelMin; p.querySelector('.sa-body').style.display = panelMin ? 'none' : ''; document.getElementById('sa-min').textContent = panelMin ? '+' : '–'; };
    p.querySelector('.sa-body').addEventListener('click', (ev) => { const nm = ev.target.closest('.nm'); if (!nm) return; const a = nm.dataset.acct; expandedAcct = (expandedAcct === a ? null : a); renderPanel(); });
    return p;
  }
  function renderPanel() {
    const p = ensurePanel(); const q = sortedQueue(); const left = q.filter((l) => !dialed.has(l.acct)).length;
    p.querySelector('.sa-hd').firstChild.textContent = `Call Queue — ${left} left / ${q.length}${paused ? ' (PAUSED)' : ''}`;
    let h = '<div class="sa-hint">▲ answered · ▼ no answer · Esc pause · f scan · Enter start</div><div class="sa-sec">To call (in order)</div><ol class="sa-q">';
    q.forEach((l) => { const cur = currentLead && l.acct === currentLead.acct; const cls = (dialed.has(l.acct) ? 'done ' : '') + (cur ? 'cur' : '');
      let iss = ''; if (l.type === 'tech') { if (l.issue === null) iss = '<span class="iss">…</span>'; else if (typeof l.issue === 'string' && l.issue !== 'none') iss = `<span class="iss">${esc(l.issue)}</span>`; }
      const sz = l.size ? `<span class="sz">${esc(l.size)}</span>` : '';
      const svc = (l.acct === expandedAcct) ? `<div class="svc">${(l.services && l.services.length) ? l.services.map((s) => esc(s)).join('<br>') : 'no treatments found'}</div>` : '';
      h += `<li class="${cls.trim()}">${cur ? '▶ ' : ''}<span class="chip ${l.type}">${l.type === 'tech' ? 'Tech' : 'CXL'}</span>${sz}<b class="nm" data-acct="${esc(l.acct)}">${esc(l.name)}</b> <span class="ph">${l.phone}</span><span class="nc">${l.noteCount === 1 ? '1 note' : l.noteCount + ' notes'}</span>${iss}${svc}</li>`; });
    h += '</ol>'; const groups = {}; others.forEach((o) => { (groups[o.label] = groups[o.label] || []).push(o); });
    h += `<div class="sa-sec">Log — not calling (${others.length})</div>`;
    Object.keys(groups).sort().forEach((lab) => { h += `<div class="glab">${esc(lab || '(no label)')} — ${groups[lab].length}</div>`; groups[lab].forEach((o) => { h += `<div class="orow">${esc(o.name)} <span class="ph">${o.phone}</span></div>`; }); });
    p.querySelector('.sa-body').innerHTML = h;
    saveState();
  }
  function badge(text, bg) {
    let b = document.getElementById('sa-badge'); if (!b) { b = document.createElement('div'); b.id = 'sa-badge'; b.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;color:#fff;font:600 13px/1.4 system-ui,sans-serif;padding:9px 13px;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.35);pointer-events:none;max-width:400px;white-space:pre-line;'; document.body.appendChild(b); }
    b.style.background = bg || '#0E94D2'; b.textContent = text;
  }
  function copyLog() { if (!others.length) { badge('Log empty — f to scan', '#c0392b'); return; } const text = others.map((o) => `${o.label}\t${o.name}\t${o.e164}`).join('\n'); try { GM_setClipboard(text, 'text'); badge(`Log copied (${others.length})`, '#0E94D2'); } catch (e) { console.log(text); } }
  function clearAll() { callQueue.length = 0; others.length = 0; seenAccts.clear(); dialed.clear(); running = false; busy = false; paused = false; callState = 'idle'; currentLead = null; try { GM_setValue(STORE_KEY, null); } catch (e) {} const p = document.getElementById('sa-panel'); if (p) p.remove(); badge('Cleared — f to scan', '#0E94D2'); }

  function stopAll() { running = false; bridgeHangup(); callState = 'idle'; renderPanel(); badge('STOPPED', '#c0392b'); }
  function handleCmd(cmd) {
    if (cmd === 'pause') { togglePause(); return; }
    if (cmd === 'hold') { toggleHold(); return; }
    if (cmd === 'stop') { stopAll(); return; }
    if (paused && cmd !== 'run' && cmd !== 'start') return;
    if (cmd === 'up') onAnswerKey();
    else if (cmd === 'down') onNoAnswerKey();
    else if (cmd === 'resolve') onResolve();
    else if (cmd === 'run' || cmd === 'start') doRun();
  }
  // push queue state to the bridge so the phone control page can show it
  setInterval(() => {
    try {
      const q = sortedQueue();
      const c = currentLead;
      bridge('/state', 'POST', JSON.stringify({
        left: q.filter((l) => !dialed.has(l.acct)).length, total: q.length, paused: paused, state: callState,
        cur: c ? { name: c.name, phone: c.phone, type: c.type, size: c.size || '', acct: c.acct, notes: c.noteCount || 0, issue: (typeof c.issue === 'string' ? c.issue : ''), services: c.services || [], notesList: c.notesList || [], raw: (typeof c.raw === 'string' ? c.raw : '') } : null,
        queue: q.map((l) => ({ name: l.name, phone: l.phone, type: l.type, size: l.size || '', issue: (typeof l.issue === 'string' ? l.issue : ''), done: dialed.has(l.acct), cur: !!(c && c.acct === l.acct) })),
      }));
    } catch (e) {}
  }, 1500);
  // message templates editable from the control page ({name} placeholder)
  async function getTemplates() {
    try { const t = await bridge('/config'); if (t) { const c = JSON.parse(t); return { insect: c.insect || '', disease: c.disease || '' }; } } catch (e) {}
    return { insect: '', disease: '' };
  }
  let bridgeOk = null;
  function setBridge(ok) { if (ok === bridgeOk) return; bridgeOk = ok; const p = document.getElementById('sa-panel'); if (p) p.querySelector('.sa-hd').style.background = ok ? (paused ? '#f39c12' : '#0E94D2') : '#c0392b'; }
  setInterval(async () => { const txt = await bridge('/poll'); if (txt == null) { setBridge(false); return; } setBridge(true); txt.split(',').map((s) => s.trim()).filter(Boolean).forEach(handleCmd); }, 350);

  document.addEventListener('keydown', (e) => {
    const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const k = e.key;
    if (k === SCAN_KEY) { e.preventDefault(); scan(); }
    else if (k === START_KEY) { e.preventDefault(); doRun(); }
    else if (k === ANSWER_KEY) { e.preventDefault(); onAnswerKey(); }
    else if (k === NOANS_KEY) { e.preventDefault(); onNoAnswerKey(); }
    else if (k === 'r' || k === 'R') { e.preventDefault(); onResolve(); }
    else if (k === 'h' || k === 'H') { e.preventDefault(); toggleHold(); }
    else if (k === COPY_KEY) { e.preventDefault(); copyLog(); }
    else if (k === CLEAR_KEY) { e.preventDefault(); clearAll(); }
    else if (k === PAUSE_KEY) { e.preventDefault(); togglePause(); }
  }, true);

  if (loadState()) { renderPanel(); badge(`Loaded saved queue — ${callQueue.filter((l) => !dialed.has(l.acct)).length} to call, ${dialed.size} done.\nauto/Enter = call · f = rescan · ▲/▼ · Esc pause`, '#0E94D2'); }
  else badge('Ready — waiting for bridge (run the .bat).\n▲ answered · ▼ no answer · Esc pause', '#0E94D2');
})();
