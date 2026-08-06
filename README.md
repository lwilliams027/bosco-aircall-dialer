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
| `sod-texter.user.js` | Separate userscript: sod / lawn-disease text campaigns |
| `resolve-multi.user.js` | Separate userscript: resolve Tech Notes with 3+ notes |
| `texted-split.user.js` | Separate userscript: split leads by texted note (+ A/B breakdown) |
| `campaign-pipeline.user.js` | Separate userscript: fall-aeration campaign (HubSpot + Aircall Power Dialer) |
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

## Text campaigns (`sod-texter.user.js`)

A **separate** userscript with two campaigns, chosen by the tabs at the top of its panel
(**bottom-left** on the call log). Install it alongside the dialer.

- **🐛 Sod Webworm** — leads flagged sod webworm. **A/B test**: split 50/50 between a
  *with-price* prompt (Surface Insect / Grub Killer for their lawn size) and a *no-price*
  prompt, balanced across one-note vs multi-note.
- **🍄 Lawn Disease** — leads flagged leaf spot / dollar spot. **Everyone gets the quote**
  (Lawn Disease Curative/Preventer for their size). Dollar-spot leads get the dollar-spot
  script, leaf-spot leads get the leaf-spot script.

Each campaign keeps its **own** permanent ledger, so they're tracked separately.

1. **BUILD LIST** — **reuses the dialer's scan** (the dialer publishes its enriched queue to
   shared page storage), so it's instant. It takes only `Sales Call - Tech Note` leads flagged
   for the active campaign — already excluding anyone who has that treatment — with their note
   count and lawn size. Any tech lead the dialer hasn't classified yet is checked in the background
   (5 histories at once). **So run the dialer scan (`f`) first and let it finish.**
2. It builds the plan for the active campaign (sod = A/B split; disease = all quoted). The built
   list is **saved per campaign** — it survives reloads and loads first when you reopen the panel.
3. With **Auto-text once the list is built** checked (default on), it starts texting on its own
   after a 5-second arming window as soon as the build finishes — uncheck Auto to cancel, or hit
   **STOP TEXTING** mid-run. Otherwise **preview** first (tap a name to see the exact message) and
   press **TEXT ALL** yourself.
4. Each lead is texted through the Aircall bridge, then gets a note in Bosco
   (`… quote texted (price) - <date>`). It does **not** resolve the call — they stay in Tech Notes
   so you still call them. The permanent **ledger** keeps them off the texting list: once texted,
   re-building or re-running never texts them again. A failed note is flagged `note failed`.
   "Reset ledger" (double-confirmed) starts fresh.

> **Lawn Disease is the default campaign.** The bridge must be running and Aircall logged in.
> Cap defaults to **0** (whole list); set a number for a small test run. Copy ledger exports the
> full texted list.

## Campaign pipeline (`campaign-pipeline.user.js`)

A **separate app** for the fall-aeration campaign, run through **Aircall's Power Dialer** with the
lead's **HubSpot** contact open. Install the userscript on HubSpot (`app.hubspot.com`); it's driven
by the same global keys through the bridge. A small **📣 Campaign Pipeline** panel sits bottom-right.

- **Enter** (while HubSpot is focused) — start / resume the Power Dialer session.
- **Down = NO ANSWER** — in order: (1) **text** the lead the fall-aeration message through Aircall,
  (2) in HubSpot, if the contact **has an email** → Email → Sequences → enroll in **"2026 AF CAMP
  Landon"**; if **no email** → create a task named **"af camp 2"**, then (3) **Skip** to the next
  call. It only skips *after* the text + HubSpot step finish.
- **Up = answered** — first press **pauses** the session (so you can talk); **Up again = next call**.

Setup: the dialer bridge must be running (`start-dialer.bat`) and Aircall must be open. The script
turns on "campaign mode" on the bridge automatically (so Up/Down route here instead of the Bosco
dialer). Run the Bosco dialer **or** the campaign pipeline, not both at once.

> **v0.1 — needs live tuning.** HubSpot's page is complex; the sequence/task steps use best-effort,
> text-based selectors and log each step to the console (F12). If a step misses, open the console,
> note the last `[campaign]` line, and it can be pinned to the exact button.

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
