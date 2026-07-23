/* =====================================================================
   Aircall TEXT tester — paste into the AIRCALL DevTools Console.
   Then run:   sendTestText("+18105840614", "test message")
   Use a number you can receive on (e.g. your own cell) — if it reaches
   the end it WILL actually send. Watch the [test-text] logs to see which
   step fails.
   ===================================================================== */
(function () {
  const log = (...a) => console.log('%c[test-text]', 'color:#0E94D2;font-weight:bold', ...a);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  function setV(el, v) {
    const p = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const d = Object.getOwnPropertyDescriptor(p, 'value').set;
    d.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true }));
    d.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  window.sendTestText = async function (number, message) {
    log('START', number);

    // 1) find / open the New Conversation "To" input
    let input = q('[data-test=start-conversation-input]');
    if (!input) {
      log('To input not found — clicking "start a conversation"');
      const s = q('[data-test=start-conversation], #sidenav-start-conversation');
      log('start-conversation button:', s);
      if (s) s.click();
      await wait(700);
      input = q('[data-test=start-conversation-input]');
    }
    if (!input) { log('❌ STILL no To input — stop'); return; }
    log('✓ To input found; entering number');
    setV(input, number); input.focus();
    await wait(1000);

    // 2) the Message button
    let msg = q('[data-test=start-message]');
    log('Message button:', msg, '| disabled?', msg && msg.disabled);
    if (!msg) { log('❌ no Message button (number may not be recognized). Look for the button and send me its data-test.'); return; }
    // wait a bit if disabled
    for (let i = 0; i < 20 && msg.disabled; i++) { await wait(200); msg = q('[data-test=start-message]'); }
    log('clicking Message (disabled now?', msg.disabled, ')');
    msg.click();
    await wait(1200);

    // 3) the message textarea
    let ta = q('[data-test=send-message-input]');
    log('message textarea:', ta);
    if (!ta) { log('❌ no message textarea — the Message view did not open. Send me the DOM of the message box.'); return; }
    log('✓ typing message');
    setV(ta, message); ta.focus();
    await wait(600);

    // 4) the Send button
    let send = q('[data-test=send-message], [aria-label*="Send"]');
    log('Send button:', send, '| disabled?', send && send.disabled);
    if (!send) { log('❌ no Send button — send me its DOM.'); return; }
    for (let i = 0; i < 20 && send.disabled; i++) { await wait(200); send = q('[data-test=send-message], [aria-label*="Send"]'); }
    log('clicking Send (disabled now?', send.disabled, ')');
    send.click();
    log('✅ SEND CLICKED — check if the text actually went out.');
  };

  console.log('%c[test-text] ready → run:  sendTestText("+1XXXXXXXXXX", "test message")', 'color:#7BBF43;font-weight:bold');
})();
