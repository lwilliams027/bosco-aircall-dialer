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
<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dialer Control</title><style>
body{margin:0;font:15px system-ui,-apple-system,sans-serif;background:#0f1720;color:#e8eef4}
header{background:#0E94D2;color:#fff;padding:12px 14px;font-weight:700;position:sticky;top:0;z-index:5}
.btns{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;padding:10px}
.btns2{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:0 10px 10px}
button{border:0;border-radius:10px;padding:18px 8px;font-size:15px;font-weight:700;color:#fff;background:#2b3a48;cursor:pointer}
button:active{filter:brightness(1.25)}
.start{background:#7BBF43}.stop{background:#c0392b}.pause{background:#f39c12}
.up{background:#7BBF43;font-size:18px}.down{background:#c0392b;font-size:18px}
.sec{padding:10px 12px 4px;font-weight:700;color:#7fb7d8;border-top:1px solid #22303c;margin-top:6px}
ol{margin:0;padding:0 12px 12px 30px}li{margin:7px 0;line-height:1.35}
li.done{opacity:.35;text-decoration:line-through}
li.cur{background:#16324a;border-radius:6px;padding:5px;margin-left:-5px}
.chip{font-size:11px;font-weight:700;padding:1px 5px;border-radius:4px;margin-right:5px}
.tech{background:#7BBF43;color:#04310f}.cxl{background:#c0392b;color:#fff}
.sz{background:#0E94D2;padding:1px 5px;border-radius:4px;font-size:11px;margin-right:5px}
.iss{color:#ff9b9b;font-weight:700;font-size:11px;margin-left:6px;text-transform:uppercase}
.ph{color:#7fb7d8}
textarea{width:100%;box-sizing:border-box;min-height:110px;background:#16202b;color:#e8eef4;border:1px solid #2b3a48;border-radius:8px;padding:8px;font:13px system-ui}
.save{background:#0E94D2;margin-top:8px;width:100%}
.stat{padding:4px 12px 8px;color:#9ab;font-size:13px}
.lbl{font-size:12px;color:#9ab;margin:8px 0 4px}
</style></head><body>
<header>Dialer Control <span id="conn" style="float:right;font-size:12px;font-weight:400">…</span></header>
<div class="btns">
<button class="start" onclick="cmd('start')">START</button>
<button class="pause" onclick="cmd('pause')">PAUSE</button>
<button class="stop" onclick="cmd('stop')">STOP</button>
</div>
<div class="btns2">
<button class="up" onclick="cmd('up')">&#9650; ANSWERED</button>
<button class="down" onclick="cmd('down')">&#9660; NO ANSWER</button>
</div>
<div class="stat" id="stat">-</div>
<div class="sec">Queue</div>
<ol id="q"></ol>
<div class="sec">Edit messages</div>
<div style="padding:0 12px 30px">
<div class="lbl">Insect / sod webworm - use {name}</div>
<textarea id="insect"></textarea>
<div class="lbl">Disease / leaf + dollar spot - use {name}</div>
<textarea id="disease"></textarea>
<button class="save" onclick="saveCfg()">SAVE MESSAGES</button>
</div>
<script>
function cmd(c){fetch('/cmd',{method:'POST',body:c}).catch(function(){});}
function saveCfg(){
 var b={insect:document.getElementById('insect').value,disease:document.getElementById('disease').value};
 fetch('/config',{method:'POST',body:JSON.stringify(b)}).then(function(){alert('Saved');}).catch(function(){alert('Save failed');});
}
var cfgLoaded=false;
function esc(s){return String(s==null?'':s).replace(/[&<>]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;'}[c];});}
function tick(){
 fetch('/state').then(function(r){return r.json();}).then(function(s){
  document.getElementById('conn').textContent='connected';
  document.getElementById('stat').textContent=(s.left||0)+' left / '+(s.total||0)+(s.paused?' - PAUSED':'')+(s.current?(' - now: '+s.current):'');
  var q=document.getElementById('q');q.innerHTML='';
  (s.queue||[]).forEach(function(l){
   var li=document.createElement('li');
   li.className=(l.done?'done ':'')+(l.cur?'cur':'');
   li.innerHTML='<span class="chip '+(l.type==='tech'?'tech':'cxl')+'">'+(l.type==='tech'?'Tech':'CXL')+'</span>'+
    (l.size?'<span class="sz">'+esc(l.size)+'</span>':'')+'<b>'+esc(l.name)+'</b> <span class="ph">'+esc(l.phone)+'</span>'+
    (l.issue&&l.issue!=='none'?'<span class="iss">'+esc(l.issue)+'</span>':'');
   q.appendChild(li);
  });
 }).catch(function(){document.getElementById('conn').textContent='offline';});
 if(!cfgLoaded){fetch('/config').then(function(r){return r.json();}).then(function(c){
   if(c&&c.insect)document.getElementById('insect').value=c.insect;
   if(c&&c.disease)document.getElementById('disease').value=c.disease;cfgLoaded=true;}).catch(function(){});}
}
setInterval(tick,1200);tick();
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
if ($lanOnly) { Write-Host "NOTE: localhost only - run setup-phone-control.bat as admin once to enable phone access." -ForegroundColor Yellow }
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
