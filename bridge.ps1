# Aircall bridge: CDP to Aircall + local HTTP control server + global Up/Down hotkeys.
#   Serves a phone-friendly control page at  http://<pc-ip>:8123/
#   Routes: GET /  | GET /poll | POST /cmd | GET|POST /state | GET|POST /config
#           POST /dial | POST /hangup | POST /text
param([int]$Port = 9222, [int]$WebPort = 8123)
$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Hk {
  [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
  [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
  [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
  [DllImport("user32.dll")] public static extern bool PeekMessage(out MSG m, IntPtr hWnd, uint min, uint max, uint remove);
}
"@

function Get-WsUrl($port) {
  $t = Invoke-RestMethod "http://127.0.0.1:$port/json" -TimeoutSec 4
  ($t | Where-Object { $_.type -eq 'page' -and $_.webSocketDebuggerUrl } | Select-Object -First 1).webSocketDebuggerUrl
}

Write-Host "Connecting to Aircall on port $Port ..." -ForegroundColor Cyan
$wsUrl = Get-WsUrl $Port
if (-not $wsUrl) { throw "No Aircall page target on port $Port" }
$ws = [System.Net.WebSockets.ClientWebSocket]::new()
$ws.ConnectAsync([Uri]$wsUrl, [Threading.CancellationToken]::None).Wait()
Write-Host "Aircall connected." -ForegroundColor Green

$script:id = 0
function Send-CDP($method, $params) {
  $script:id++
  $obj = @{ id = $script:id; method = $method }; if ($params) { $obj.params = $params }
  $bytes = [Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Compress -Depth 8))
  $ws.SendAsync([ArraySegment[byte]]::new($bytes), 'Text', $true, [Threading.CancellationToken]::None).Wait()
  $buf = [byte[]]::new(16384)
  try { $ws.ReceiveAsync([ArraySegment[byte]]::new($buf), [Threading.CancellationToken]::None).Wait(600) | Out-Null } catch {}
}
# Alt+N = Aircall "new conversation" (resets to a clean dial screen)
function NewConv() {
  Send-CDP 'Input.dispatchKeyEvent' @{ type='keyDown'; key='Alt'; code='AltLeft'; windowsVirtualKeyCode=18; modifiers=0 }
  Send-CDP 'Input.dispatchKeyEvent' @{ type='keyDown'; key='n'; code='KeyN'; windowsVirtualKeyCode=78; modifiers=1 }
  Send-CDP 'Input.dispatchKeyEvent' @{ type='keyUp'; key='n'; code='KeyN'; windowsVirtualKeyCode=78; modifiers=1 }
  Send-CDP 'Input.dispatchKeyEvent' @{ type='keyUp'; key='Alt'; code='AltLeft'; windowsVirtualKeyCode=18; modifiers=0 }
}
function Dial($num) {
  $js = "(function(n){function fill(t){var i=document.querySelector('[data-test=start-conversation-input]');if(!i){var s=document.querySelector('[data-test=start-conversation],#sidenav-start-conversation');if(s)s.click();if(t<12)return setTimeout(function(){fill(t+1)},250);return;}var d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;d.call(i,n);i.dispatchEvent(new Event('input',{bubbles:true}));i.focus();var c=0;(function call(){var b=document.querySelector('[data-test=start-call]');if(b&&!b.disabled){b.click();return;}if(c++<25)setTimeout(call,150);})();}fill(0);})('$num');"
  Send-CDP 'Runtime.evaluate' @{ expression = $js }
}
function HangUp() {
  Send-CDP 'Input.dispatchKeyEvent' @{ type='keyDown'; key='Alt'; code='AltLeft'; windowsVirtualKeyCode=18; modifiers=0 }
  Send-CDP 'Input.dispatchKeyEvent' @{ type='keyDown'; key='q'; code='KeyQ'; windowsVirtualKeyCode=81; modifiers=1 }
  Send-CDP 'Input.dispatchKeyEvent' @{ type='keyUp'; key='q'; code='KeyQ'; windowsVirtualKeyCode=81; modifiers=1 }
  Send-CDP 'Input.dispatchKeyEvent' @{ type='keyUp'; key='Alt'; code='AltLeft'; windowsVirtualKeyCode=18; modifiers=0 }
}
function Eval-Result($js) {
  $script:id++; $myid = $script:id
  $obj = @{ id = $myid; method = 'Runtime.evaluate'; params = @{ expression = $js; awaitPromise = $true; returnByValue = $true } } | ConvertTo-Json -Compress -Depth 8
  $bytes = [Text.Encoding]::UTF8.GetBytes($obj)
  $ws.SendAsync([ArraySegment[byte]]::new($bytes), 'Text', $true, [Threading.CancellationToken]::None).Wait()
  $sb = New-Object System.Text.StringBuilder
  $deadline = (Get-Date).AddSeconds(25)
  while ((Get-Date) -lt $deadline) {
    $buf = [byte[]]::new(65536); $rt = $ws.ReceiveAsync([ArraySegment[byte]]::new($buf), [Threading.CancellationToken]::None)
    if (-not $rt.Wait(6000)) { continue }
    [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf, 0, $rt.Result.Count))
    if ($rt.Result.EndOfMessage) { $t = $sb.ToString(); [void]$sb.Clear(); try { $o = $t | ConvertFrom-Json } catch { continue }; if ($o.id -eq $myid) { return $o.result.result.value } }
  }
  return 'no-response'
}
function SendText($num, $msg) {
  $nJson = ($num | ConvertTo-Json); $mJson = ($msg | ConvertTo-Json)
  $js = "(function(n,m){var q=function(s){return document.querySelector(s);};function setV(el,v){var p=el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;var d=Object.getOwnPropertyDescriptor(p,'value').set;d.call(el,'');el.dispatchEvent(new Event('input',{bubbles:true}));d.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}function wait(ms){return new Promise(function(r){setTimeout(r,ms);});}return new Promise(function(resolve){(async function(){var steps=[];var sc=q('#sidenav-start-conversation,[data-test=start-conversation]');if(sc){sc.click();steps.push('opened');}else{steps.push('no-open-btn');}var input=null;for(var k=0;k<24&&!input;k++){await wait(250);input=q('[data-test=start-conversation-input]');}if(!input){resolve('FAIL: no To input | '+steps.join(','));return;}steps.push('input-ok');setV(input,n);input.focus();await wait(1000);var msg=q('[data-test=start-message]');for(var i=0;i<24&&(!msg||msg.disabled);i++){await wait(200);msg=q('[data-test=start-message]');}if(!msg){resolve('FAIL: no Message btn | '+steps.join(','));return;}steps.push('msgbtn(disabled='+msg.disabled+')');msg.click();await wait(1000);var ta=null;for(var j=0;j<24&&!ta;j++){await wait(200);ta=q('[data-test=send-message-input]');}if(!ta){resolve('FAIL: no textarea | '+steps.join(','));return;}steps.push('textarea-ok');setV(ta,m);ta.focus();await wait(600);var send=q('[data-test=send-message],[aria-label*=Send]');for(var h=0;h<24&&(!send||send.disabled);h++){await wait(200);send=q('[data-test=send-message],[aria-label*=Send]');}if(!send){resolve('FAIL: no Send btn | '+steps.join(','));return;}steps.push('sendbtn(disabled='+send.disabled+')');send.click();resolve('SENT | '+steps.join(','));})();});})($nJson,$mJson);"
  $r = Eval-Result $js
  Start-Sleep -Milliseconds 800; NewConv; Start-Sleep -Milliseconds 400; NewConv   # after texting, Alt+N twice to reset to a clean dial screen
  Write-Host "[text] $num -> $r" -ForegroundColor Green
  return $r
}

# ---------------- control page ----------------
$PAGE = @'
<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0f1720"><title>Dialer</title><style>
:root{--bg:#0f1720;--card:#18232f;--line:#25333f;--txt:#eef4f9;--dim:#95a9ba;--blue:#0E94D2;--grn:#7BBF43;--red:#e0574a;--amb:#f39c12}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;background:var(--bg);color:var(--txt);font:16px/1.4 -apple-system,system-ui,Segoe UI,sans-serif;padding-bottom:24px}
header{position:sticky;top:0;z-index:10;background:#0c131b;border-bottom:1px solid var(--line);
  padding:11px 16px;display:flex;align-items:center;justify-content:space-between}
header b{font-size:16px;letter-spacing:.3px}
header .hb{background:#1b2632;border:1px solid var(--line);color:#8fd3ef;font-size:12px;font-weight:800;
  padding:7px 13px;border-radius:9px;margin-left:auto;margin-right:12px}
#dot{font-size:12px;color:var(--dim);display:flex;align-items:center;gap:6px}
#dot::before{content:"";width:9px;height:9px;border-radius:50%;background:#556}
#dot.on::before{background:var(--grn)} #dot.off::before{background:var(--red)}
.wrap{max-width:560px;margin:0 auto;padding:12px}

/* current customer */
.cur{background:linear-gradient(180deg,#1b3247,#172230);border:1px solid #2a4056;border-radius:16px;padding:16px;margin-bottom:12px}
.cur.hide{display:none}
.pill{display:inline-block;font-size:11px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;
  padding:4px 10px;border-radius:20px;background:#24384a;color:#bcd}
.pill.ring{background:#3a2a12;color:#ffd28a} .pill.call{background:#173a1e;color:#a7e6b0} .pill.paused{background:#3a1414;color:#ffb3ab}
.cname{font-size:26px;font-weight:800;margin:8px 0 2px;line-height:1.1}
.cphone{font-size:20px;font-weight:700;color:#dbe9f4}
.cmeta{color:var(--dim);font-size:13px;margin-top:3px}
.noneu{color:var(--dim);text-align:center;padding:22px 0}

/* buttons */
.two{display:grid;grid-template-columns:1fr 1fr;gap:10px}
button{border:0;border-radius:14px;font-weight:800;color:#fff;cursor:pointer;font-family:inherit}
.big{padding:22px 8px;font-size:17px}
.up{background:var(--grn);color:#08320f} .down{background:var(--red)} .resolve{background:var(--blue)}
button:active{filter:brightness(1.22)}
/* quiet control bar */
.bar{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-top:10px}
.bb{padding:13px 2px;font-size:11px;letter-spacing:.3px;background:#1b2632;color:#9fb4c6;
  border:1px solid var(--line);border-radius:11px}
.bb.act{background:var(--amb);color:#3a2600;border-color:var(--amb)}
.bb.hot{color:#e08a80}
.bb:disabled{opacity:.32;cursor:default}

/* view buttons + sections */
.viewbtns{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px}
.vb{padding:13px 4px;font-size:13px;font-weight:700;background:#22303c;color:#cfe1ef;border:1px solid #33475a;border-radius:10px}
.vb.price{background:#123a4d;color:#8fd3ef;border-color:#1d5871}
.vb.on{background:var(--blue);color:#fff;border-color:var(--blue)}
.vsec{margin-top:10px;background:#0f1720;border:1px solid #2a4056;border-radius:10px;padding:10px;max-height:260px;overflow:auto}
.note{padding:6px 0;border-bottom:1px solid #22303c;font-size:13px} .note:last-child{border-bottom:0}
.note .nl{color:#8fc7e8;font-size:11px;font-weight:700;margin-bottom:2px}
.svcrow{padding:4px 0;font-size:13px;color:#cfe1ef}
.condflag{display:inline-block;background:var(--red);color:#fff;font-weight:800;font-size:12px;letter-spacing:.4px;
  padding:5px 11px;border-radius:8px;margin-bottom:8px;text-transform:uppercase}
.condraw{font-size:13px;color:#cfe1ef;white-space:pre-wrap;line-height:1.45}
.empty{color:var(--dim)}

/* queue */
.qhead{display:flex;align-items:center;gap:10px;margin:20px 4px 8px}
.qhead .t{font-size:13px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;color:#8fc7e8}
.qhead .c{color:var(--dim);font-size:13px;margin-left:auto}
.qhead .tg{background:#1b2632;border:1px solid var(--line);color:#9fb4c6;font-size:11px;font-weight:800;
  padding:6px 11px;border-radius:8px}
ol{list-style:none;margin:0;padding:0}
li{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:11px 12px;margin-bottom:8px;display:flex;align-items:center;gap:8px}
li.done{opacity:.4} li.done .nm{text-decoration:line-through}
li.cur{border-color:var(--blue);background:#16324a}
.chip{font-size:10px;font-weight:800;padding:2px 6px;border-radius:5px;flex-shrink:0}
.tech{background:var(--grn);color:#08320f} .cxl{background:var(--red);color:#fff}
.qsz{background:var(--blue);color:#fff;font-size:11px;font-weight:800;padding:1px 6px;border-radius:5px;flex-shrink:0}
.qmid{flex:1;min-width:0} .qmid .nm{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qmid .ph{color:var(--dim);font-size:13px}
.qiss{color:#ff9b9b;font-weight:800;font-size:11px;text-transform:uppercase;flex-shrink:0}

/* price sheet overlay */
.overlay{position:fixed;inset:0;z-index:50;background:var(--bg);transform:translateX(100%);transition:transform .22s ease;
  display:flex;flex-direction:column}
.overlay.open{transform:translateX(0)}
.oh{position:sticky;top:0;background:#0c131b;border-bottom:1px solid var(--line);padding:12px 14px;
  display:flex;align-items:center;gap:12px;font-weight:800;font-size:17px}
.oh .back{background:#22303c;padding:9px 14px;font-size:14px;border-radius:10px}
.pbody{overflow:auto;padding:14px;max-width:560px;margin:0 auto;width:100%}
.pricebar{display:flex;align-items:center;gap:12px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;margin-bottom:8px;position:sticky;top:0}
.pricebar label{color:var(--dim);font-size:13px}
.pricebar input{flex:1;max-width:120px;background:#0f1720;border:1px solid #2b3a48;border-radius:10px;color:#fff;
  padding:13px;font-size:22px;text-align:center;font-weight:800}
.pgrp{margin:16px 0 6px;color:#8fc7e8;font-weight:800;font-size:13px;text-transform:uppercase;letter-spacing:.5px}
.prow{display:flex;justify-content:space-between;gap:12px;padding:11px 2px;border-bottom:1px solid var(--line)}
.pn{font-size:15px} .pg{color:#7fb7d8;font-size:11px}
.pr{text-align:right;white-space:nowrap} .pp{font-weight:800;font-size:17px;color:var(--grn)} .pt{display:block;color:var(--dim);font-size:12px}
</style></head><body>

<header><b>Dialer</b><button class="hb" onclick="openPrice()">PRICES</button><span id="dot">connecting...</span></header>

<div class="wrap">
  <div class="cur hide" id="cur">
    <span class="pill" id="cst">-</span>
    <div class="cname" id="cnm"></div>
    <div class="cphone" id="cph"></div>
    <div class="cmeta" id="cmeta"></div>
    <div class="viewbtns">
      <button class="vb" id="vbn" onclick="toggleView('vnotes')">Notes</button>
      <button class="vb" id="vbt" onclick="toggleView('vtreat')">Treatments</button>
      <button class="vb" id="vbc" onclick="toggleView('vcond')">Conditions</button>
      <button class="vb price" onclick="openPrice()">&#128181; Price</button>
    </div>
    <div class="vsec" id="vnotes" style="display:none"></div>
    <div class="vsec" id="vtreat" style="display:none"></div>
    <div class="vsec" id="vcond" style="display:none"></div>
  </div>
  <div class="noneu" id="none">Not on a call. Tap START.</div>

  <div class="two">
    <button class="big up" id="b1" onclick="cmd('up')">&#9650; ANSWERED</button>
    <button class="big down" id="b2" onclick="act2()">&#9660; NO ANSWER</button>
  </div>
  <div class="bar">
    <button class="bb" onclick="cmd('start')">START</button>
    <button class="bb" id="bhold" onclick="cmd('hold')">&#128222; HOLD</button>
    <button class="bb" onclick="cmd('pause')">PAUSE</button>
    <button class="bb" onclick="fetch('/newconv',{method:'POST'}).catch(function(){})">&#8635; RESET</button>
    <button class="bb hot" onclick="cmd('stop')">STOP</button>
  </div>

  <div class="qhead"><span class="t">Queue</span><span class="c" id="qc">-</span><button class="tg" id="qtg" onclick="toggleQ()">Show all</button></div>
  <ol id="q"></ol>
</div>

<div class="overlay" id="ps">
  <div class="oh"><button class="back" onclick="closePrice()">&larr; Back</button> Price Sheet</div>
  <div class="pbody">
    <div class="pricebar"><label>Lawn size<br>&times;1,000 sqft</label>
      <input id="psize" type="number" inputmode="decimal" min="0" step="0.5" oninput="renderPrices()"></div>
    <div id="prices"></div>
  </div>
</div>

<script>
function cmd(c){fetch('/cmd',{method:'POST',body:c}).catch(function(){});}
function esc(s){return String(s==null?'':s).replace(/[&<>]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});}
function openPrice(){document.getElementById('ps').classList.add('open');}
function closePrice(){document.getElementById('ps').classList.remove('open');}
var answered=false;
function act2(){ if(answered){cmd('resolve');}else{cmd('down');} }
var showAllQ=false,QN=8;
function toggleQ(){showAllQ=!showAllQ;tick();}
var openView='';
function toggleView(id){
 openView=(openView===id)?'':id;
 document.getElementById('vnotes').style.display=(openView==='vnotes')?'':'none';
 document.getElementById('vtreat').style.display=(openView==='vtreat')?'':'none';
 document.getElementById('vcond').style.display=(openView==='vcond')?'':'none';
 document.getElementById('vbn').className='vb'+(openView==='vnotes'?' on':'');
 document.getElementById('vbt').className='vb'+(openView==='vtreat'?' on':'');
 document.getElementById('vbc').className='vb'+(openView==='vcond'?' on':'');
}

var lastPricedAcct='';
var SVCS={'Lawn Care':[
  {n:'Lawn Care',b:59,r:5,apps:7,g:'5 apps'},
  {n:'Organic Lawn Care',b:82,r:11,apps:7,g:'5 apps'},
  {n:'Grub Prevention',b:99,r:12,apps:1,g:'365 Days'},
  {n:'Surface Insect / Grub Killer',b:145,r:18,apps:1,g:'60 Days'},
  {n:'Aeration',b:129,r:15,apps:1,g:''},
  {n:'Overseeding',b:164,r:20,apps:1,g:''},
  {n:'Lawn Disease Curative/Preventer',b:173,r:20,apps:1,g:'Full Season'},
  {n:'Water Maximizer',b:115,r:17,apps:1,g:''},
  {n:'Potassium',b:59,r:4,apps:1,g:''},
  {n:'Soil Treatment Program',b:63,r:5.5,apps:1,g:''},
  {n:'Soil Test',flat:75,apps:1,g:''}],
 'Safari Tree':[
  {n:'Tree Care',b:63,r:5,apps:7,g:'5 apps'},
  {n:'Mole Control',b:167,r:12,apps:4,g:'Full Program'},
  {n:'Mole Control (single app)',b:250,r:17,apps:1,g:'45 Days'},
  {n:'Deep Root',b:63,r:5,apps:3,g:''},
  {n:'Mosquito, Flea & Tick',b:125,r:5,apps:5,g:'Full Program'},
  {n:'Natural Mosquito, Flea & Tick',b:175,r:7,apps:5,g:'Full Program'},
  {n:'Tri-Annual',flat:600,apps:3,g:'Full Program'},
  {n:'Vole Control',b:69,r:4,apps:1,g:'45 Days'}],
 'Trees':[
  {n:'Tree Fungicide (Scab/Blight)',flat:65,apps:1,g:''}]};
function per(s,z){return s.flat!=null?s.flat:(z<=5?s.b:s.b+(z-5)*s.r);}
function money(v){return '$'+(Math.round(v*100)/100).toFixed(2);}
function renderPrices(){
 var z=parseFloat(document.getElementById('psize').value)||0;var h='';
 Object.keys(SVCS).forEach(function(grp){
  h+='<div class="pgrp">'+grp+'</div>';
  SVCS[grp].forEach(function(s){
   var p=per(s,z),right;
   if(s.apps>1){var se=p*s.apps;right='<span class="pp">'+money(p)+'/app</span><span class="pt">'+money(se)+' season &middot; '+money(se*0.93)+' prepay</span>';}
   else{right='<span class="pp">'+money(p)+'</span>';}
   h+='<div class="prow"><div class="pn">'+esc(s.n)+(s.g?' <span class="pg">'+esc(s.g)+'</span>':'')+'</div><div class="pr">'+right+'</div></div>';
  });
 });
 document.getElementById('prices').innerHTML=h;
}

function tick(){
 fetch('/state').then(function(r){return r.json();}).then(function(s){
  document.getElementById('dot').className='on';document.getElementById('dot').textContent='connected';
  var bh=document.getElementById('bhold');if(s.paused){bh.innerHTML='&#9654; RESUME';bh.className='bb act';}else{bh.innerHTML='&#128222; HOLD';bh.className='bb';}
  document.getElementById('qc').textContent=(s.left||0)+' left / '+(s.total||0)+(s.paused?' - PAUSED':'');
  var c=s.cur,box=document.getElementById('cur'),none=document.getElementById('none');
  if(c){
   box.classList.remove('hide');none.style.display='none';
   var st=s.paused?'PAUSED':(s.state==='answered'?'ON CALL':(s.state==='ringing'?'RINGING':'-'));
   var cls=s.paused?'paused':(s.state==='answered'?'call':(s.state==='ringing'?'ring':''));
   var pill=document.getElementById('cst');pill.textContent=st;pill.className='pill '+cls;
   answered=(s.state==='answered'&&!s.paused);
   var b1=document.getElementById('b1'),b2=document.getElementById('b2');
   if(answered){b1.innerHTML='&#10142; GO NEXT';b1.className='big up';b2.innerHTML='&#10003; RESOLVE';b2.className='big resolve';}
   else{b1.innerHTML='&#9650; ANSWERED';b1.className='big up';b2.innerHTML='&#9660; NO ANSWER';b2.className='big down';}
   var iss=(c.issue&&c.issue!=='none')?(' - '+c.issue.toUpperCase()):'';
   document.getElementById('cnm').textContent=(c.name||'')+iss+(c.size?(' '+c.size+'k'):'');
   document.getElementById('cph').textContent=c.phone||'';
   document.getElementById('cmeta').textContent=(c.type==='tech'?'Tech Note':'CXL')+' - '+(c.notes||0)+' note'+((c.notes===1)?'':'s')+' - acct '+(c.acct||'');
   document.getElementById('vnotes').innerHTML=(c.notesList&&c.notesList.length)?c.notesList.map(function(n){return '<div class="note"><div class="nl">'+esc(n.when||'')+(n.who?(' - '+esc(n.who)):'')+'</div>'+esc(n.text||'')+'</div>';}).join(''):'<div class="empty">No notes on file.</div>';
   document.getElementById('vtreat').innerHTML=(c.services&&c.services.length)?c.services.map(function(x){return '<div class="svcrow">'+esc(x)+'</div>';}).join(''):'<div class="empty">No programs found.</div>';
   var hasIss=(c.issue&&c.issue!=='none'),ch='';
   if(hasIss){ch+='<div class="condflag">'+esc(c.issue.toUpperCase())+'</div>';}
   if(c.raw){ch+='<div class="condraw">'+esc(c.raw)+'</div>';}
   else if(!hasIss){ch+='<div class="empty">No conditions listed on the account.</div>';}
   document.getElementById('vcond').innerHTML=ch;
   if(c.size&&String(c.acct)!==lastPricedAcct&&document.activeElement!==document.getElementById('psize')){lastPricedAcct=String(c.acct);document.getElementById('psize').value=c.size;renderPrices();}
  } else { box.classList.add('hide');none.style.display='';answered=false;
   var b1=document.getElementById('b1'),b2=document.getElementById('b2');
   b1.innerHTML='&#9650; ANSWERED';b1.className='big up';b2.innerHTML='&#9660; NO ANSWER';b2.className='big down'; }
  var q=document.getElementById('q');q.innerHTML='';
  var full=s.queue||[];
  var pend=full.filter(function(l){return !l.done;});
  var list=showAllQ?full:pend.slice(0,QN);
  document.getElementById('qtg').textContent=showAllQ?('Up next ('+Math.min(QN,pend.length)+')'):('Show all ('+full.length+')');
  list.forEach(function(l){
   var li=document.createElement('li');li.className=(l.done?'done ':'')+(l.cur?'cur':'');
   li.innerHTML='<span class="chip '+(l.type==='tech'?'tech':'cxl')+'">'+(l.type==='tech'?'T':'C')+'</span>'+
    (l.size?'<span class="qsz">'+esc(l.size)+'</span>':'')+
    '<span class="qmid"><span class="nm">'+esc(l.name)+'</span> <span class="ph">'+esc(l.phone)+'</span></span>'+
    (l.issue&&l.issue!=='none'?'<span class="qiss">'+esc(l.issue)+'</span>':'');
   q.appendChild(li);
  });
 }).catch(function(){document.getElementById('dot').className='off';document.getElementById('dot').textContent='offline';});
}
renderPrices();setInterval(tick,1200);tick();
</script></body></html>
'@

# ---------------- global hotkeys ----------------
$WM_HOTKEY = 0x0312
[Hk]::RegisterHotKey([IntPtr]::Zero, 1, 0, 0x26) | Out-Null   # VK_UP
[Hk]::RegisterHotKey([IntPtr]::Zero, 2, 0, 0x28) | Out-Null   # VK_DOWN

# ---------------- http server ----------------
$listener = New-Object System.Net.HttpListener
$bound = $false
foreach ($p in @("http://+:$WebPort/", "http://127.0.0.1:$WebPort/")) {
  try { $listener.Prefixes.Clear(); $listener.Prefixes.Add($p); $listener.Start(); $bound = $true; Write-Host "Listening on $p" -ForegroundColor Green; break } catch {}
}
if (-not $bound) { throw "Could not start the web server on port $WebPort" }
$lanOnly = ($listener.Prefixes -join '') -like '*127.0.0.1*'
if ($lanOnly) { Write-Host "NOTE: localhost only - run setup-phone.bat as admin once to enable phone access." -ForegroundColor Yellow }
else {
  $ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1).IPAddress
  Write-Host "PHONE CONTROL:  http://$ip`:$WebPort/   (same Wi-Fi)" -ForegroundColor Cyan
}

$queue = New-Object System.Collections.Generic.List[string]
$queue.Add('run')
$script:state = '{}'
$script:config = '{}'
Write-Host "Bridge ready. Up = answered, Down = no answer. Leave this window open." -ForegroundColor Green

$ctxTask = $listener.GetContextAsync()
$msg = New-Object Hk+MSG
while ($ws.State -eq 'Open') {
  while ([Hk]::PeekMessage([ref]$msg, [IntPtr]::Zero, $WM_HOTKEY, $WM_HOTKEY, 1)) {
    if ($msg.message -eq $WM_HOTKEY) {
      $hid = $msg.wParam.ToInt32()
      if ($hid -eq 1) { $queue.Add('up'); Write-Host "up" -ForegroundColor Yellow }
      elseif ($hid -eq 2) { $queue.Add('down'); Write-Host "down" -ForegroundColor Yellow }
    }
  }
  if ($ctxTask.Wait(50)) {
    $ctx = $ctxTask.Result
    try {
      $path = $ctx.Request.Url.AbsolutePath; $out = 'ok'; $ctype = 'text/plain'
      $body = ''
      if ($ctx.Request.HasEntityBody) { $body = (New-Object IO.StreamReader($ctx.Request.InputStream)).ReadToEnd() }
      if ($path -eq '/' -or $path -eq '/index.html') { $out = $PAGE; $ctype = 'text/html; charset=utf-8' }
      elseif ($path -eq '/poll') { $out = ($queue -join ','); $queue.Clear() }
      elseif ($path -eq '/cmd') { $c = $body.Trim(); if ($c) { $queue.Add($c); Write-Host "cmd $c" -ForegroundColor Yellow } }
      elseif ($path -eq '/state') { if ($ctx.Request.HttpMethod -eq 'POST') { $script:state = $body } else { $out = $script:state; $ctype = 'application/json' } }
      elseif ($path -eq '/config') { if ($ctx.Request.HttpMethod -eq 'POST') { $script:config = $body; Write-Host "config saved" -ForegroundColor Cyan } else { $out = $script:config; $ctype = 'application/json' } }
      elseif ($path -eq '/dial') { $b = $body.Trim(); if ($b -match '^\+1\d{10}$') { Dial $b; Write-Host "dial $b" -ForegroundColor Cyan } }
      elseif ($path -eq '/hangup') { HangUp; Write-Host "hangup" -ForegroundColor Magenta }
      elseif ($path -eq '/newconv') { NewConv; Write-Host "new conv (Alt+N)" -ForegroundColor Cyan }
      elseif ($path -eq '/text') { try { $o = $body | ConvertFrom-Json; if ($o.number -match '^\+1\d{10}$') { $out = (SendText $o.number $o.message) } else { $out = 'bad number' } } catch { $out = 'text error' } }
      $ctx.Response.Headers.Add('Access-Control-Allow-Origin', '*')
      $ctx.Response.ContentType = $ctype
      $bytes = [Text.Encoding]::UTF8.GetBytes([string]$out)
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length); $ctx.Response.Close()
    } catch {}
    $ctxTask = $listener.GetContextAsync()
  }
}
[Hk]::UnregisterHotKey([IntPtr]::Zero, 1) | Out-Null
[Hk]::UnregisterHotKey([IntPtr]::Zero, 2) | Out-Null
$listener.Stop()
Write-Host "Stopped." -ForegroundColor Red
