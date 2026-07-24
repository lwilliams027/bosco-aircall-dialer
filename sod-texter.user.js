// ==UserScript==
// @name         Bosco Sod Texter
// @namespace    local.sa.sodtexter
// @version      1.7
// @updateURL    https://raw.githubusercontent.com/lwilliams027/bosco-aircall-dialer/main/sod-texter.user.js
// @downloadURL  https://raw.githubusercontent.com/lwilliams027/bosco-aircall-dialer/main/sod-texter.user.js
// @description  Text campaigns for Tech Notes: Sod Webworm (A/B price vs no-price) and Lawn Disease (leaf/dollar spot, everyone quoted). Reuses the dialer's scan, previews, texts through the Aircall bridge, logs a note (leaves the call in Tech Notes to be called). Per-campaign permanent ledger prevents double-texting.
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
      const t0 = Date.now();
      while (Date.now() - t0 < 15000 && document.querySelectorAll('tr.dx-data-row').length === 0) await sleep(400);
      const rows = Array.from(document.querySelectorAll('tr.dx-data-row')).filter((r) => /\bL0[1-9]\b/i.test(r.innerText || ''));
      let sod = 0, dollar = 0, leaf = 0;
      for (const r of rows) {                                         // scan ALL treatment rows (all-time), not just recent
        r.click(); await sleep(700);
        const body = (document.body.innerText || '').toLowerCase();
        if (/sod\s*webworm/.test(body)) sod = 1;
        if (body.includes('dollar spot')) dollar = 1;
        if (body.includes('leaf spot')) leaf = 1;
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
      const hasDiseaseTx = /lawn disease|disease control|disease treatment|(?:prevent|curat)\w*\s*\w*\s*disease|disease\s*\w*\s*(?:prevent|curat)/.test(svc) ? 1 : 0;
      let size = ''; try { const mm = ((document.querySelector('#DetailProperty') || document.body).innerText || '').match(/(\d+(?:\.\d+)?)\s*1000\s*sq\s*ft/i); if (mm) size = String(parseInt(mm[1], 10)); } catch (e) {}
      console.log('[sx-scan]', acct, { sod, dollar, leaf, hasSodTx, hasDiseaseTx, size });
      try { GM_setValue('sx_condition', { acct: String(acct), sod, dollar, leaf, hasSodTx, hasDiseaseTx, size, ts: Date.now() }); } catch (e) {}
    })(histM[1]);
    return;
  }

  // only build the panel on the call log
  if (!/CallLog/i.test(location.href)) return;

  // ========================= helpers =========================
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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

  // reuse the dialer's scan: it publishes its enriched queue here (shared page localStorage)
  const readSharedQueue = () => { try { const st = JSON.parse(localStorage.getItem('sa_shared_queue') || 'null'); return (st && Array.isArray(st.q)) ? st : null; } catch (e) { return null; } };
  const pickLead = (l, sizeOverride, issueOverride) => ({ acct: l.acct, name: l.name || '(lead)', phone: l.phone || '', e164: l.e164 || '',
    noteCount: (typeof l.noteCount === 'number' ? l.noteCount : 1), size: (sizeOverride != null && sizeOverride !== '') ? sizeOverride : (l.size || ''),
    issue: issueOverride || l.issue || '' });

  // ---- Bosco note + resolve (ported from the dialer, drives the call log DOM) ----
  const todayStr = () => { const d = new Date(); return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`; };
  function setNative(el, val) { const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
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
  function openNoteEditor() {
    let b = document.querySelector('a.action-new-note:not(.disabled)') || document.querySelector('a.action-new-note');
    if (!b) { const plus = document.querySelector('.panel-tools.message-actions .fa-plus, .message-actions .fa-plus'); b = plus ? plus.closest('a,button,li') : null; }
    if (b) { b.click(); return true; } return false;
  }
  const findNoteTextarea = () => Array.from(document.querySelectorAll('#callDetails textarea, .expandedView textarea, textarea.form-control')).find((t) => t.offsetParent !== null) || null;
  async function selectBlankOutcome() {
    const toggle = document.querySelector('button[data-id="ReasonID"]');
    const group = toggle ? toggle.closest('.bootstrap-select') : (document.querySelector('#ReasonID') ? document.querySelector('#ReasonID').closest('.bootstrap-select') : null);
    if (!group) return;
    const tg = group.querySelector('.dropdown-toggle') || toggle; if (tg) tg.click(); await sleep(180);
    const isBlank = (li) => ((li.querySelector('a') || {}).textContent || '').replace(/ /g, '').trim() === '';
    const items = Array.from(group.querySelectorAll('.dropdown-menu li'));
    const target = items.find((li) => !li.classList.contains('selected') && isBlank(li)) || items.find(isBlank);
    const a = target ? target.querySelector('a') : null;
    if (a) a.click(); else if (tg) tg.click(); await sleep(180);
  }
  async function addNoteAndSave(text) {
    if (!openNoteEditor()) { console.warn('[sx-note] editor not opened'); return false; }
    await sleep(500); const ta = findNoteTextarea();
    if (ta) setNative(ta, text); else { console.warn('[sx-note] textarea not found'); return false; }
    await selectBlankOutcome();
    const save = document.querySelector('#SaveNewNote'); if (save) save.click(); else { console.warn('[sx-note] #SaveNewNote not found'); return false; }
    await sleep(900); return true;
  }
  // log a note that the text went out — does NOT resolve the call, so they stay in Tech Notes to be called
  async function noteLead(item) {
    const row = await findRow(item.lead.acct);
    if (!row) { console.warn('[sx-note] row not found', item.lead.acct); return false; }
    const prev = notesSig(); openLeadRow(row); await waitForNotes(prev);
    return await addNoteAndSave(item.note);
  }

  // Surface Insect / Grub Killer: $145 base (<=5k), +$18 per 1k over 5
  function surfacePrice(size) { const z = parseFloat(size) || 0; const p = z <= 5 ? 145 : 145 + (z - 5) * 18; return '$' + Math.round(p); }
  // Lawn Disease Curative/Preventer: $173 base (<=5k), +$20 per 1k over 5
  function diseasePrice(size) { const z = parseFloat(size) || 0; const p = z <= 5 ? 173 : 173 + (z - 5) * 20; return '$' + Math.round(p); }
  const sizeKnown = (size) => !!(parseFloat(size));

  // ========================= messages =========================
  // Sod webworm (A/B: with price / without)
  const MSG_SOD_PRICE = (n, price) => `Hey ${n} this is Landon with Lush Lawn Safari Tree, you had a technician out the other day and he just wanted me to send you a text to let you know he did a good job on the application and you should start seeing some results pretty quickly! He also wanted me to let you know he found an insect called sod webworm. Basically they are a surface feeding insect that eats your grass. The problem is, now that they're in your lawn they will continue to feed on your grass, potentially killing off sections of the lawn causing you to repair and reseed those areas. So what we do is put down an insecticide called Dylox, which will kill the sod webworm and stop them from doing any further damage and its guaranteed. I just wanted to make sure its okay to do for you before any further damage was done! Its one treatment for ${price} guaranteeing your lawn is protected for 60 days! I'll shoot you a call to address this issue in a few but if you would like me to go forward with this for you right now let me know!`;
  const MSG_SOD_NOPRICE = (n) => `Hey ${n} this is Landon with Lush Lawn Safari Tree, you had a technician out the other day and he just wanted me to send you a text to let you know he did a good job on the application and you should start seeing some results pretty quickly! He also wanted me to let you know he found an insect called sod webworm. Basically they are a surface feeding insect that eats your grass. The problem is, now that they're in your lawn they will continue to feed on your grass, potentially killing off sections of the lawn causing you to repair and reseed those areas. So what we do is put down an insecticide called Dylox, which will kill the sod webworm and stop them from doing any further damage and its guaranteed. I just wanted to make sure its okay to do for you before any further damage was done! I'll shoot you a call to address this issue in a few but if you would like me to go forward with this for you right now let me know!`;
  // Lawn disease (everyone gets the quote; message depends on which disease)
  const MSG_DOLLAR = (n, price) => `Hey ${n} this is Landon with Lush Lawn Safari Tree, you had a technician out the other day and he just wanted me to send you a text to let you know he did a good job on the application and you should start seeing some results pretty quickly! He also wanted me to let you know he found a fungus in your lawn called dollar spot. Basically, it is a fungus usually caused from dry soil conditions and moisture in the air. In server cases you will notice brown circles roughly the size of a silver dollar. the problem is as it continues to thrive, the small circles eventually bleed into each other eventually thinning out large sections of your lawn. So what we do is put down a lawn disease curative which will also prevent it from coming back and it's guaranteed! I just wanted to make sure its okay to do for you before any further damage was done! Its one treatment for ${price} guaranteeing your lawn is protected for a FULL YEAR! I'll shoot you a call to address this issue in a few but if you would like me to go forward with this for you right now let me know!`;
  const MSG_LEAF = (n, price) => `Hey ${n} this is Landon with Lush Lawn Safari Tree, you had a technician out the other day and he just wanted me to send you a text to let you know he did a good job on the application and you should start seeing some results pretty quickly! He also wanted me to let you know he found a fungus in your lawn called leaf spot. Its nothing you are we did wrong. Basically, it is a fungus caused from stagnate water in spring that rots the roots of your grass, creating the environment for a fungus to form. If you were to pick up a grass blade it would look like it was burnt with a lighter. The problem is that it thrives in heat causing it to go through a phase called "melting out" in which that little burn spot looks like it's melting, eventually taking over the entire grass blade, thinning out sections of your lawn potentially causing you to repair and reseed, which is expensive. So what we do is put down a lawn disease curative which will also prevent it from coming back and it's guaranteed. I just wanted to make sure that was okay to do for you before any further damage is done! Its one treatment for ${price} guaranteeing your lawn is protected for a FULL YEAR! I'll shoot you a call to address this issue in a few but if you would like me to go forward with this for you right now let me know!`;

  // ========================= campaigns =========================
  const CAMPAIGNS = {
    sod: { label: 'Sod Webworm', emoji: '🐛', issues: ['sod webworm'], ledgerKey: 'sx_texted', ab: true,
      // import from the dialer's detection: prefer the per-condition flags, fall back to the issue tag
      fromShared: (l) => l.act ? ({ ok: !!l.act.sod, issue: 'sod webworm' }) : ({ ok: l.issue === 'sod webworm', issue: 'sod webworm' }),
      gapMatch: (c) => ({ ok: !!(c.sod && !c.hasSodTx), issue: 'sod webworm' }) },
    disease: { label: 'Lawn Disease', emoji: '🍄', issues: ['leaf spot', 'dollar spot'], ledgerKey: 'sx_texted_disease', ab: false,
      fromShared: (l) => l.act ? ({ ok: !!(l.act.dollar || l.act.leaf), issue: l.act.dollar ? 'dollar spot' : 'leaf spot' })
        : ({ ok: ['leaf spot', 'dollar spot'].includes(l.issue), issue: l.issue }),
      gapMatch: (c) => ({ ok: !!((c.dollar || c.leaf) && !c.hasDiseaseTx), issue: c.dollar ? 'dollar spot' : 'leaf spot' }) },
  };
  let campaign = 'sod'; try { campaign = GM_getValue('sx_campaign', 'sod'); if (!CAMPAIGNS[campaign]) campaign = 'sod'; } catch (e) {}
  const camp = () => CAMPAIGNS[campaign];

  // ========================= permanent do-not-double-text ledger (per campaign) =========================
  let ledger = {};
  function loadLedger() { try { ledger = GM_getValue(camp().ledgerKey, {}) || {}; } catch (e) { ledger = {}; } }
  loadLedger();
  const alreadyTexted = (acct) => Object.prototype.hasOwnProperty.call(ledger, acct);
  function recordTexted(lead, tag, noted) { ledger[lead.acct] = { name: lead.name, when: Date.now(), tag, noted: !!noted }; try { GM_setValue(camp().ledgerKey, ledger); } catch (e) {} }

  // ========================= state =========================
  let scanning = false, sending = false, plan = [], skippedTexted = 0;
  let cap = 10; try { cap = GM_getValue('sx_cap', 10); } catch (e) {}   // first-run cap; 0 = no limit

  function lookupIssue(acct) {
    return new Promise((resolve) => {
      let done = false, lid = null, tab = null;
      const finish = (v) => { if (done) return; done = true; try { if (lid != null) GM_removeValueChangeListener(lid); } catch (e) {} try { if (tab && tab.close) tab.close(); } catch (e) {} resolve(v); };
      try { lid = GM_addValueChangeListener('sx_condition', (n, o, v) => { if (v && String(v.acct) === String(acct)) finish(v); }); } catch (e) {}
      try { GM_setValue('sx_pending_' + acct, Date.now()); } catch (e) {}
      try { tab = GM_openInTab(`https://bosco.serviceassistant.com/172154/Customer/customer/index/${acct}/history`, { active: false, insert: true }); } catch (e) {}
      setTimeout(() => finish({ sod: 0, dollar: 0, leaf: 0, hasSodTx: 0, hasDiseaseTx: 0, size: '' }), 35000);
    });
  }

  // ========================= build the list from the dialer's scan =========================
  async function runScan() {
    if (scanning) { scanning = false; return; }                      // second click = stop gap-fill
    if (sending) return;
    const st = readSharedQueue();
    const tech = (st ? st.q : []).filter((l) => l && l.type === 'tech' && l.acct);   // TECH NOTES ONLY
    if (!tech.length) { plan = []; setStatus('No dialer scan found. Open the dialer, press f, let it finish scanning, then Build here.'); render(); return; }
    scanning = true; plan = []; skippedTexted = 0;
    const seen = new Set(), qualifying = [];
    // 1) instant: import straight from the dialer's detection for this campaign (already excludes anyone who has the treatment)
    for (const l of tech) {
      if (seen.has(l.acct)) continue; seen.add(l.acct);
      if (alreadyTexted(l.acct)) { skippedTexted++; continue; }
      const m = camp().fromShared(l);
      if (m.ok) qualifying.push(pickLead(l, null, m.issue));
    }
    const capHit = () => cap > 0 && qualifying.length >= cap;
    // 2) safety net: tech leads the dialer hasn't classified yet — check them in parallel (fast)
    let gaps = capHit() ? [] : tech.filter((l) => (l.issue === undefined || l.issue === null) && !alreadyTexted(l.acct) && !qualifying.some((x) => x.acct === l.acct));
    setStatus(`Dialer scan: ${qualifying.length} ${camp().label.toLowerCase()} ready${gaps.length ? `, checking ${gaps.length} unscanned…` : ''}`); render();
    if (gaps.length) {
      let gi = 0; const CONC = 5;                                     // 5 histories at once
      const worker = async () => { while (scanning && gi < gaps.length && !capHit()) { const l = gaps[gi++]; const c = await lookupIssue(l.acct); const m = camp().gapMatch(c); if (m.ok) { qualifying.push(pickLead(l, c.size, m.issue)); render(); } } };
      await Promise.all(Array.from({ length: Math.min(CONC, gaps.length) }, worker));
    }
    scanning = false;
    let finalLeads = qualifying;
    if (cap > 0 && finalLeads.length > cap) finalLeads = shuffle(finalLeads).slice(0, cap);
    plan = buildPlan(finalLeads);
    setStatus(plan.length
      ? `Ready — ${plan.length} to text${cap > 0 && qualifying.length > cap ? ` (capped from ${qualifying.length})` : ''}${skippedTexted ? `, ${skippedTexted} already texted` : ''}`
      : `No un-texted ${camp().label.toLowerCase()} tech notes (${skippedTexted} already texted).`);
    render();
  }

  // ========================= build the plan (campaign-aware) =========================
  function buildPlan(leads) {
    if (camp().ab) {
      // SOD: A/B 50/50 balanced by note count
      const one = shuffle(leads.filter((l) => l.noteCount === 1));
      const multi = shuffle(leads.filter((l) => l.noteCount !== 1));
      const price = [], noprice = [];
      one.forEach((l, i) => (i % 2 === 0 ? price : noprice).push(l));     // one-note split 50/50
      multi.forEach((l, i) => (i % 2 === 0 ? noprice : price).push(l));   // multi split 50/50, offset so totals stay even
      return price.map((l) => mkItem(l, true)).concat(noprice.map((l) => mkItem(l, false)));
    }
    // DISEASE: everyone gets the quote
    return leads.map((l) => mkItem(l, true));
  }
  function mkItem(l, withPrice) {
    const n = firstName(l.name), group = l.noteCount === 1 ? '1-note' : 'multi';
    if (campaign === 'sod') {
      const price = surfacePrice(l.size);
      return { lead: l, withPrice, group, sizeOk: sizeKnown(l.size),
        message: withPrice ? MSG_SOD_PRICE(n, price) : MSG_SOD_NOPRICE(n),
        note: `Sod webworm text sent (${withPrice ? 'price' : 'no price'}) - ${todayStr()}`,
        tag: withPrice ? 'price' : 'noprice', chip: withPrice ? 'PRICE' : 'NO PRICE', chipCls: withPrice ? 'p' : 'n',
        priceStr: withPrice ? price : '' };
    }
    // disease
    const isDollar = l.issue === 'dollar spot', price = diseasePrice(l.size);
    return { lead: l, withPrice: true, group, sizeOk: sizeKnown(l.size),
      message: isDollar ? MSG_DOLLAR(n, price) : MSG_LEAF(n, price),
      note: `${isDollar ? 'Dollar spot' : 'Leaf spot'} quote texted (${price}) - ${todayStr()}`,
      tag: l.issue, chip: isDollar ? 'DOLLAR SPOT' : 'LEAF SPOT', chipCls: 'p', priceStr: price };
  }

  // ========================= send =========================
  async function sendAll() {
    if (sending || scanning || !plan.length) return;
    const todo = plan.filter((p) => !alreadyTexted(p.lead.acct));
    if (!todo.length) { setStatus('Everyone in this plan has already been texted.'); render(); return; }
    const ping = await bridge('/state', 'GET');
    if (ping == null) { alert('Bridge not reachable.\nStart the dialer bridge (start-dialer.bat) and make sure Aircall is logged in, then try again.'); return; }
    if (!confirm(`Text ${todo.length} leads now — ${camp().label}?\n\n${camp().ab ? `Price prompt: ${todo.filter((p) => p.withPrice).length}\nNo-price prompt: ${todo.filter((p) => !p.withPrice).length}` : `Everyone gets the quote.`}\n\nEach one is texted, gets a note logged, and is recorded so they can't be texted again. They STAY in Tech Notes to be called.`)) return;
    sending = true; let sent = 0, failed = 0, unnoted = 0;
    for (const item of todo) {
      if (!sending) break;
      if (alreadyTexted(item.lead.acct)) continue;                    // final guard
      setStatus(`Texting ${sent + 1}/${todo.length} — ${item.lead.name}…`); render();
      const resp = await bridge('/text', 'POST', JSON.stringify({ number: item.lead.e164, message: item.message }));
      const ok = resp != null && !/error|bad number|not found|fail/i.test(resp);
      if (!ok) { failed++; item.failed = true; console.warn('[sx-send] text failed', item.lead.acct, resp); render(); await sleep(1500); continue; }
      item.sent = true; sent++;
      // log a note (no status change — keeps them in Tech Notes)
      setStatus(`Logging note for ${item.lead.name}…`); render();
      let noted = false; try { noted = await noteLead(item); } catch (e) { console.error('[sx-note]', e); }
      if (!noted) unnoted++;
      item.noted = noted;
      recordTexted(item.lead, item.tag, noted);   // recorded either way (they WERE texted)
      render();
      await sleep(1500);
    }
    sending = false;
    setStatus(`Done — ${sent} texted${unnoted ? `, ${unnoted} note-failed` : ', all noted'}${failed ? `, ${failed} text-failed` : ''}. Ledger: ${Object.keys(ledger).length}.`);
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
  #sxp .camps{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px}
  #sxp .camp{background:#1b2632;color:#9fb4c6;border:1px solid #2a3a48;border-radius:10px;padding:11px 6px;font-size:13px;font-weight:800}
  #sxp .camp.on{background:#0f94d2;color:#fff;border-color:#0f94d2}
  #sxp .row{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  #sxp button{border:0;border-radius:10px;font-weight:800;color:#fff;cursor:pointer;font-family:inherit;padding:12px 8px;font-size:13px}
  #sxp .scan{background:#22303c} #sxp .scan.on{background:#f39c12;color:#3a2600}
  #sxp .send{background:#7BBF43;color:#08320f;width:100%;margin-top:9px;padding:15px}
  #sxp .send:disabled{opacity:.4;cursor:default}
  #sxp .capln{display:flex;align-items:center;gap:7px;margin-top:8px;color:#9fb4c6;font-size:11.5px}
  #sxp .capln input{width:58px;background:#0f1720;border:1px solid #2b3a48;border-radius:7px;color:#fff;padding:6px 8px;font-size:13px;font-weight:800;text-align:center}
  #sxp .capln .dim{opacity:.7}
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
  let statusMsg = 'Pick a campaign, then BUILD LIST from the dialer\'s scan.';
  const setStatus = (s) => { statusMsg = s; };

  function render() {
    const priceN = plan.filter((p) => p.withPrice).length, noN = plan.length - priceN;
    const one = plan.filter((p) => p.group === '1-note').length, multi = plan.length - one;
    const ab = camp().ab;
    panel.innerHTML = `
      <div class="hd"><b>${camp().emoji} ${esc(camp().label)} Texter</b><span class="x" id="sxmin">–</span></div>
      <div class="bd">
        <div class="camps">
          ${Object.keys(CAMPAIGNS).map((k) => `<button class="camp ${campaign === k ? 'on' : ''}" data-c="${k}" ${sending || scanning ? 'disabled' : ''}>${CAMPAIGNS[k].emoji} ${esc(CAMPAIGNS[k].label)}</button>`).join('')}
        </div>
        <div class="row">
          <button class="scan ${scanning ? 'on' : ''}" id="sxscan">${scanning ? 'STOP' : 'BUILD LIST'}</button>
          <button class="scan" id="sxrescan" ${scanning || sending ? 'disabled' : ''}>RESET LIST</button>
        </div>
        <div class="capln">Cap at <input id="sxcap" type="number" min="0" step="1" value="${cap}" ${scanning ? 'disabled' : ''}> leads <span class="dim">(0 = all)</span></div>
        <div class="st">${esc(statusMsg)}</div>
        ${plan.length ? `<div class="sum">
          <span class="tag">${plan.length} total</span>
          ${ab ? `<span class="tag p">💲 ${priceN} price</span><span class="tag n">no-price ${noN}</span>` : `<span class="tag p">all quoted</span>`}
          <span class="tag">1-note ${one}</span>
          <span class="tag">multi ${multi}</span>
        </div>` : ''}
        <button class="send" id="sxsend" ${(!plan.length || sending || scanning) ? 'disabled' : ''}>${sending ? 'TEXTING…' : `TEXT ALL (${plan.filter((p) => !alreadyTexted(p.lead.acct)).length})`}</button>
        <ul id="sxlist">
          ${plan.map((p, i) => `
            <li data-i="${i}" class="${p.sent ? 'sent' : ''}${p.failed ? ' failed' : ''}">
              <div class="ln">${esc(p.lead.name)}
                <span class="pr ${p.chipCls}">${esc(p.chip)}</span></div>
              <div class="meta">${esc(p.lead.phone)} · <span class="g">${p.group}</span>${p.priceStr ? ` · ${esc(p.priceStr)}${p.sizeOk ? '' : ' <span class="warn">⚠ size?</span>'}` : ''}${p.sent ? (p.noted ? ' · <span class="g">texted + noted ✓</span>' : ' · <span class="g">texted ✓</span>' + (p.noted === false ? ' · <span class="warn">note failed</span>' : '')) : ''}${p.failed ? ' · <span class="warn">text failed</span>' : ''}</div>
              <div class="msg">${esc(p.message)}</div>
            </li>`).join('')}
        </ul>
        <div class="foot">
          <span class="lg">${esc(camp().label)} ledger: ${Object.keys(ledger).length}</span>
          <button id="sxcopy">Copy ledger</button>
          <button class="clr" id="sxclear">Reset ledger</button>
        </div>
      </div>`;
    panel.querySelector('#sxmin').onclick = () => panel.classList.toggle('min');
    panel.querySelectorAll('.camp').forEach((b) => { b.onclick = () => { if (sending || scanning) return; const k = b.dataset.c; if (k === campaign) return; campaign = k; try { GM_setValue('sx_campaign', k); } catch (e) {} loadLedger(); plan = []; setStatus(`${camp().label} — press BUILD LIST.`); render(); }; });
    panel.querySelector('#sxscan').onclick = runScan;
    panel.querySelector('#sxrescan').onclick = () => { plan = []; setStatus('List cleared. Build again to rebuild.'); render(); };
    const capEl = panel.querySelector('#sxcap'); if (capEl) capEl.onchange = (e) => { cap = Math.max(0, parseInt(e.target.value, 10) || 0); try { GM_setValue('sx_cap', cap); } catch (err) {} };
    panel.querySelector('#sxsend').onclick = sendAll;
    panel.querySelector('#sxcopy').onclick = () => { try { GM_setClipboard(JSON.stringify(ledger, null, 2)); setStatus('Ledger copied to clipboard.'); render(); } catch (e) {} };
    panel.querySelector('#sxclear').onclick = () => {
      if (!confirm(`Reset the ${camp().label} do-not-text ledger?\n\nThis erases the record of ${Object.keys(ledger).length} texted people — they could be texted again. This cannot be undone.`)) return;
      if (!confirm('Are you absolutely sure? Only do this to start a brand new campaign.')) return;
      ledger = {}; try { GM_setValue(camp().ledgerKey, ledger); } catch (e) {} setStatus('Ledger cleared.'); render();
    };
    panel.querySelectorAll('#sxlist li').forEach((li) => { li.querySelector('.ln').onclick = () => li.classList.toggle('open'); });
  }
  render();
})();
