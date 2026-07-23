# Bosco Call Queue + Aircall Auto-Dialer

A Tampermonkey userscript for the Bosco (Service Assistant) call log, plus a small
local bridge (batch + PowerShell) that drives the **Aircall desktop app** — including
a phone-friendly web control page.

## What it does

- Builds a **prioritized call queue** from the call log — only `Sales Call - Tech Note`
  and `Customer S - CXL Customer C/B` leads, single-note first. Every other label goes
  into a "not calling" log.
- **Dials each lead through Aircall**, driven by global Up/Down keys (work anywhere on
  screen) or the web control page.
- On **no answer**, it looks up the customer's recent lawn condition, sends the matching
  text (Tech leads only), logs a note, and reschedules or resolves the call.
- **Remembers the queue** between page reloads.

## Files

| File | Purpose |
|---|---|
| `sa-find-number.user.js` | The Tampermonkey userscript (the main thing) |
| `aircall-autofill.bat` | Double-click launcher for the bridge |
| `aircall-inject.ps1` | Bridge engine: Aircall CDP + web control server + hotkeys |
| `setup-phone-control.bat` | Run once **as admin** to allow phone access |
| `test-text.bat` | Fires one test text through the bridge |
| `sa-test-text.js` | Optional Aircall-console text tester |

## Setup (one time)

1. Install **Tampermonkey** in Edge/Chrome.
2. Go to `edge://extensions` → enable **Developer mode** → Tampermonkey → **Details** →
   turn on **"Allow user scripts"**.
3. Install the userscript (see *Install / update* below).
4. First time it talks to the bridge, Tampermonkey asks to connect to `127.0.0.1` →
   click **Always allow**.
5. For phone control: right-click `setup-phone-control.bat` → **Run as administrator**.

## Daily use

1. Open the Bosco call-log tab.
2. Double-click **`aircall-autofill.bat`** (restarts Aircall once so it can be
   automated). Leave the black window open — it prints the phone URL.
3. Panel header in Bosco turns **blue** = bridge connected.
4. It loads the saved queue (or press `f` to rescan) and starts calling.

### Keys (work anywhere while the bridge runs)

| Key | Action |
|---|---|
| `Up` | Answered — hang up and go to the next lead |
| `Down` | No answer — log note, text if a condition is found, next |
| `Esc` | Pause (hangs up) / resume (redials same lead) |
| `f` | Rescan the list from scratch |
| `Enter` | Start calling the queue |
| `s` | Copy the "not calling" log |
| `c` | Clear everything (also wipes the saved queue) |

> While the bridge runs, Up/Down are captured system-wide (they won't scroll other
> apps). Close the bridge window to release them.

### Phone control

Open the URL the bridge prints (e.g. `http://192.168.1.50:8123/`) on a phone on the
same Wi-Fi. You get START / PAUSE / STOP, ▲ ANSWERED / ▼ NO ANSWER, the live queue,
and editable message templates (`{name}` = customer first name).

## Condition texting

On a no-answer for a **Tech** lead, it reads treatments from the **last 30 days** and
picks **one** issue by priority:

`moles` → `sod webworm` → `disease (leaf/dollar spot)`

It skips an issue if the customer already has that treatment, then drops to the next.

- **sod webworm** → surface-insecticide text
- **leaf / dollar spot** → lawn-disease text
- **moles** → left alone (no text)

Toggle real sending with `SEND_TEXTS = true/false` near the top of the userscript.

## Install / update the userscript

Open the raw file and Tampermonkey will offer to install it. After that it can
auto-update from the same URL.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Panel header **red** | Bridge not reachable — run `aircall-autofill.bat` |
| "Invalid Userscript" | You pasted the wrong file — use `sa-find-number.user.js` |
| `Down` does nothing | Header must be blue and a lead must be RINGING; check the bridge window prints `down` |
| Not finding an issue | F12 → Console, look for `[sa-scan]` lines |
| Text not sending | Run `test-text.bat`; the RESULT line names the failing step |
