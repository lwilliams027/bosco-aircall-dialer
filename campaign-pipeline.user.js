// ==UserScript==
// @name         Campaign Pipeline (HubSpot + Aircall Power Dialer)
// @namespace    local.sa.campaign
// @version      0.1
// @updateURL    https://raw.githubusercontent.com/lwilliams027/bosco-aircall-dialer/main/campaign-pipeline.user.js
// @downloadURL  https://raw.githubusercontent.com/lwilliams027/bosco-aircall-dialer/main/campaign-pipeline.user.js
// @description  Fall-aeration campaign pipeline. Runs on HubSpot; driven by global Up/Down through the bridge + Aircall Power Dialer. Down (no answer) = text the lead, then in HubSpot enroll in the "2026 AF CAMP Landon" sequence (if they have an email) or create an "af camp 2" task, then Skip to the next call. Up = pause, Up again = next. Enter = start/resume the dialer.
// @match        https://app.hubspot.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// ==/UserScript==

(function () {
  'use strict';
  const BRIDGE = 'http://127.0.0.1:8123';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const FALL_TEXT = 'Hey this is Landon with Lush Lawn and Safari Tree. Just a heads-up, we started scheduling for our fall Aerations. They help with root competition and soil compaction. Would you like me to put you on the schedule?';
  const SEQUENCE_NAME = '2026 AF CAMP Landon';   // the sequence to enroll into (matched loosely: "af camp" + "landon")
  const TASK_TITLE = 'af camp 2';

  function bridge(path, method, body, timeoutMs) {
    return new Promise((resolve) => {
      try { GM_xmlhttpRequest({ method: method || 'GET', url: BRIDGE + path, data: body || null, timeout: timeoutMs || 8000,
        onload: (r) => resolve(r.responseText || ''), onerror: () => resolve(null), ontimeout: () => resolve(null) });
      } catch (e) { resolve(null); }
    });
  }

  // ---------- DOM helpers (find HubSpot buttons by text / aria-label, resiliently) ----------
  const visible = (el) => el && el.offsetParent !== null && !el.disabled;
  const txt = (el) => ((el.textContent || '') + ' ' + (el.getAttribute && (el.getAttribute('aria-label') || '') || '') + ' ' + (el.getAttribute && (el.getAttribute('data-selenium-test') || '') || '')).replace(/\s+/g, ' ').trim().toLowerCase();
  function findClickable(matches) {
    const wants = (Array.isArray(matches) ? matches : [matches]).map((m) => m.toLowerCase());
    const els = Array.from(document.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="option"], [role="tab"]'));
    return els.find((el) => visible(el) && wants.some((w) => txt(el) === w || txt(el).startsWith(w) || txt(el).includes(w))) || null;
  }
  async function clickWhenReady(matches, tries) {
    for (let i = 0; i < (tries || 30); i++) { const b = findClickable(matches); if (b) { b.click(); return b; } await sleep(200); }
    return null;
  }
  function setNative(el, val) {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ---------- does the open contact have an email? ----------
  function contactEmail() {
    const a = document.querySelector('a[href^="mailto:"]');
    if (a) { const e = a.getAttribute('href').replace(/^mailto:/i, '').trim(); if (/@/.test(e)) return e; }
    // header area under the contact name
    const head = document.querySelector('[data-selenium-test="profile-header"], [data-test-id="profile-header"]') || document.body;
    const m = (head.innerText || '').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    return m ? m[0] : '';
  }

  // ---------- HubSpot: enroll in the AF CAMP sequence ----------
  async function enrollSequence() {
    setStatus('HubSpot: opening Email…');
    if (!(await clickWhenReady(['Email'], 30))) return 'no-email-btn';
    await sleep(1200);
    setStatus('HubSpot: Sequences tab…');
    if (!(await clickWhenReady(['Sequences'], 30))) return 'no-sequences-tab';
    await sleep(1200);
    // "Select sequence" modal -> find the AF CAMP row and its Select button
    setStatus('HubSpot: selecting sequence…');
    let selected = false;
    for (let i = 0; i < 30 && !selected; i++) {
      const rows = Array.from(document.querySelectorAll('tr, li, [role="row"]'));
      const row = rows.find((r) => visible(r) && /af\s*camp/i.test(r.textContent || '') && /landon/i.test(r.textContent || ''))
              || rows.find((r) => visible(r) && new RegExp(SEQUENCE_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(r.textContent || ''));
      if (row) { const btn = Array.from(row.querySelectorAll('button, a, [role="button"]')).find((b) => visible(b) && /^\s*select\s*$/i.test(b.textContent || '')) || row; btn.click(); selected = true; break; }
      // fallback: click the sequence name link directly
      const link = Array.from(document.querySelectorAll('a, button, [role="button"]')).find((b) => visible(b) && /af\s*camp/i.test(b.textContent || '') && /landon/i.test(b.textContent || ''));
      if (link) { link.click(); selected = true; break; }
      await sleep(250);
    }
    if (!selected) return 'sequence-not-found';
    await sleep(1000);
    // there is usually a follow-up step (Next / Enroll / Start / Confirm) — click it if present
    await clickWhenReady(['Enroll', 'Start sequence', 'Start', 'Next', 'Confirm'], 12);
    return 'sequence-ok';
  }

  // ---------- HubSpot: create the "af camp 2" task ----------
  async function createTask() {
    setStatus('HubSpot: opening Task…');
    if (!(await clickWhenReady(['Task'], 30))) return 'no-task-btn';
    await sleep(1200);
    // task title textarea (placeholder "Enter your task")
    let ta = null;
    for (let i = 0; i < 30 && !ta; i++) { ta = document.querySelector('textarea[placeholder*="task" i], textarea[id^="input-"], .CreateTask textarea'); if (ta && !visible(ta)) ta = null; if (!ta) await sleep(200); }
    if (!ta) return 'no-task-input';
    setNative(ta, TASK_TITLE); ta.focus(); await sleep(500);
    setStatus('HubSpot: creating task…');
    if (!(await clickWhenReady(['Create', 'Create task', 'Save'], 20))) return 'no-create-btn';
    return 'task-ok';
  }

  // ---------- the NO ANSWER flow: text -> HubSpot -> skip ----------
  let busy = false;
  async function onNoAnswer() {
    if (busy) return; busy = true;
    try {
      setStatus('No answer — texting the lead…');
      const t = await bridge('/pd-text', 'POST', FALL_TEXT, 20000);   // Aircall: text the current lead (via bridge)
      const email = contactEmail();
      let r;
      if (email) { setStatus(`Email on file (${email}) — enrolling sequence…`); r = await enrollSequence(); }
      else { setStatus('No email — creating task…'); r = await createTask(); }
      await sleep(600);
      setStatus('Skipping to next call…');
      await bridge('/pd-skip', 'POST');                                // only skip AFTER texted + HubSpot done
      setStatus(`Done (${email ? 'sequence' : 'task'}: ${r}; text: ${t}). Ready.`);
    } catch (e) { console.error('[campaign] no-answer', e); setStatus('No-answer error — see console (F12).'); }
    busy = false;
  }

  // ---------- ANSWER: 1st Up = pause, 2nd Up = next ----------
  let answeredPaused = false;
  async function onAnswer() {
    if (!answeredPaused) { answeredPaused = true; setStatus('Answered — paused. Up again = next.'); await bridge('/pd-pause', 'POST'); }
    else { answeredPaused = false; setStatus('Next call…'); await bridge('/pd-skip', 'POST'); }
  }

  // ---------- poll the bridge for global Up/Down ----------
  let connected = false;
  async function poll() {
    const r = await bridge('/cpoll', 'GET');
    connected = (r !== null); dot();
    if (r) { r.split(',').filter(Boolean).forEach((c) => { if (c === 'down') onNoAnswer(); else if (c === 'up') onAnswer(); }); }
  }
  // Enter (while HubSpot is focused) starts/resumes the dialer, like the normal app
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.target.matches('input, textarea, [contenteditable="true"]')) { e.preventDefault(); setStatus('Start / resume dialer…'); bridge('/pd-start', 'POST'); }
  }, true);

  // ---------- tiny status panel ----------
  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483000;width:300px;background:#141d27;color:#e8eef4;border:1px solid #2a3a48;border-radius:12px;font:12px/1.4 system-ui,Segoe UI,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.5)';
  document.body.appendChild(panel);
  let statusMsg = 'Campaign pipeline ready. Enter = start · Down = no answer · Up = pause/next.';
  const setStatus = (s) => { statusMsg = s; render(); };
  function dot() { render(); }
  function render() {
    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:#7BBF43;color:#08320f;border-radius:12px 12px 0 0;font-weight:800">
        <span>📣 Campaign Pipeline</span>
        <span style="margin-left:auto;font-size:11px;font-weight:700;color:${connected ? '#08320f' : '#7a2a2a'}">${connected ? '● bridge' : '● offline'}</span>
      </div>
      <div style="padding:10px 12px;color:#9fb4c6">${statusMsg.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</div>`;
  }
  render();

  // turn on campaign mode (bridge routes Up/Down here) and start polling
  bridge('/cmode', 'POST', 'on');
  window.addEventListener('beforeunload', () => { try { navigator.sendBeacon(BRIDGE + '/cmode', 'off'); } catch (e) {} });
  setInterval(poll, 500);
  poll();
})();
