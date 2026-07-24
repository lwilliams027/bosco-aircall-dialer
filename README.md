# Bosco Dialer

A Tampermonkey userscript for the Bosco (Service Assistant) call log, plus a small
local bridge (batch + PowerShell) that drives the **Aircall desktop app** — including
a phone-friendly web control page.

## What it does

- Builds a **prioritized call queue** from the call log — only `Sales Call - Tech Note`
  and `Customer S - CXL Customer C/B` leads. Every other label goes into a
  "not calling" log you can copy.
- **Sorts by issue**: moles → sod webworm → leaf/dollar spot → everything else,
  then by note count.
- **Dials each lead through Aircall**, driven by global Up/Down keys (they work
  anywhere on screen) or the web control page.
- On **no answer**, logs a note and reschedules to the next business day. On the
  **second** no-answer it notes `Didn't answer twice` and resolves the call.
- On **resolve**, notes `Not interested in <treatment> - <date>` and closes it out.
- Looks up the customer's **recent lawn condition** (last 30 days of treatments) and
  shows it on the card, skipping any issue they already have the treatment for.
- **Remembers the queue** between page reloads.

## Files

| File | Purpose |
|---|---|
| `bosco-dialer.user.js` | The Tampermonkey userscript (the main thing) |
| `sod-texter.user.js` | Separate userscript: A/B sod webworm text campaign |
| `start-dialer.bat` | Double-click launcher for the bridge |
| `bridge.ps1` | Bridge engine: Aircall CDP + web control server + hotkeys |
| `setup-phone.bat` | Run once **as admin** to allow phone access |
| `docs/index.html` | GitHub Pages launcher for the phone |

## Setup (one time)

1. Install **Tampermonkey** in Edge/Chrome.
2. Go to `edge://extensions` → enable **Developer mode** → Tampermonkey → **Details** →
   turn on **"Allow user scripts"**.
3. Install the userscript (see *Install / update* below).
4. First time it talks to the bridge, Tampermonkey asks to connect to `127.0.0.1` →
   click **Always allow**.
5. For phone control: right-click `setup-phone.bat` → **Run as administrator**.

## Daily use

1. Open the Bosco call-log tab.
2. Double-click **`start-dialer.bat`** (restarts Aircall once so it can be
   automated). Leave the black window open — it prints the phone URL.
3. Panel header in Bosco turns **blue** = bridge connected.
4. It loads the saved queue (or press `f` to rescan) and starts calling.

### Keys (work anywhere while the bridge runs)

| Key | Action |
|---|---|
| `Up` | Answered — then choose **GO NEXT** or **RESOLVE** |
| `Down` | No answer — note + reschedule (2nd time: note + resolve) |
| `r` | Resolve — "not interested in \<treatment\>" note, then close |
| `h` | Hold — pause without hanging up the live call |
| `Esc` | Pause (hangs up) / resume (redials same lead) |
| `f` | Rescan the list from scratch |
| `Enter` | Start calling the queue |
| `s` | Copy the "not calling" log |
| `c` | Clear everything (also wipes the saved queue) |

> While the bridge runs, Up/Down are captured system-wide (they won't scroll other
> apps). Close the bridge window to release them.

### Phone control

Open the URL the bridge prints (e.g. `http://192.168.1.50:8123/`) on your phone —
LAN IP on the same Wi-Fi, or the **Tailscale** IP (`100.x.x.x`) from anywhere.
You get START / PAUSE / STOP, ▲ ANSWERED / ▼ NO ANSWER, the live queue, and the
current customer card:

**`John Smith - SOD WEBWORM 5k`** with **View Notes** (every note on the account,
each labeled with date + author), **Treatments** (their programs plus the observed
conditions), and **Price Chart** (size-based calculator).

## Condition lookup

On a no-answer it reads treatments from the **last 30 days** and picks **one**
issue by priority:

`moles` → `sod webworm` → `disease (leaf/dollar spot)`

It skips an issue if the customer already has that treatment, then drops to the
next. The issue drives both the queue sort order and the treatment name used in
the resolve note:

| Issue | Treatment name |
|---|---|
| moles | Mole Control |
| sod webworm | Surface Insecticide |
| leaf / dollar spot | Lawn Disease Treatment |

> Texting is currently disabled (`SEND_TEXTS = false` near the top of the userscript).

## Sod texter (A/B campaign)

A **separate** userscript (`sod-texter.user.js`) for a one-shot sod webworm text blast.
Install it alongside the dialer; its panel appears **bottom-left** on the call log.

1. **SCAN TECH NOTES** — walks every `Sales Call - Tech Note` lead, opens each history,
   detects sod webworm in the last 30 days, and **skips anyone who already has a surface
   insecticide**. Also reads note count and lawn size.
2. It splits the qualifying leads **50/50** between two prompts — one **with the Surface
   Insect / Grub Killer price** for their lawn size, one **without** — balanced so each
   prompt gets an even share of one-note vs multi-note leads.
3. **Preview** every assignment (tap a name to see the exact message). Price leads with an
   unknown lawn size show a ⚠ so you can double-check.
4. **SEND ALL** texts them through the Aircall bridge (needs the bridge running). Each person
   is written to a **permanent ledger** the moment they're texted, so re-scanning or re-running
   never double-texts anyone. "Reset ledger" (double-confirmed) starts a fresh campaign.

> The bridge must be running and Aircall logged in. Copy ledger exports the full texted list.

## Install / update the userscripts

Open a raw file and Tampermonkey will offer to install it. After that each
auto-updates from the same URL. The dialer and the sod texter install independently.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Panel header **red** | Bridge not reachable — run `start-dialer.bat` |
| "Invalid Userscript" | You pasted the wrong file — use `bosco-dialer.user.js` |
| `Down` does nothing | Header must be blue and a lead must be RINGING; check the bridge window prints `down` |
| Not finding an issue | F12 → Console, look for `[sa-scan]` lines |
| Phone can't load the page | Tailscale on (or same Wi-Fi), and `setup-phone.bat` run as admin once |
