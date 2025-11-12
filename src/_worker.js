import { connect } from "cloudflare:sockets";
import { DurableObject } from "cloudflare:workers";

/* ================== CONST ================== */
const PORTS = [443, 80];
const PROTOCOLS = ["vless", "trojan", "ss"];
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
const PRX_PER_PAGE = 24;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS,DELETE",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
  "Access-Control-Max-Age": "86400",
};

/* ================== ENTRY (with diagnostics) ================== */
export default {
  async fetch(request, env, ctx) {
    try {
      console.log("REQ", request.method, new URL(request.url).pathname);
      return await handleRequest(request, env, ctx);
    } catch (e) {
      const msg = (e && e.stack) ? e.stack : String(e);
      console.error("UNCAUGHT", msg);
      return new Response("1101 TRACE:\n" + msg, {
        status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }
  },
  async scheduled(controller, env, ctx) {
    try { ctx.waitUntil(refreshProxyList(env)); }
    catch (e) { console.error("CRON ERR", e?.stack || e); }
  }
};

/* ================== MAIN ROUTER ================== */
async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  const upgrade = request.headers.get("Upgrade");

  // --- Diagnostic endpoint ---
  if (url.pathname === "/__diag") {
    const flags = {
      has_TUNNEL_DO: !!env.TUNNEL_DO,
      has_PRX_BANK_URL: !!env.PRX_BANK_URL,
      has_CF_API_EMAIL: !!env.CF_API_EMAIL,
      has_CF_GLOBAL_API_KEY: !!env.CF_GLOBAL_API_KEY,
      env_APP: `${env.APP_SERVICE_NAME || "?"}.${env.APP_ROOT_DOMAIN || "?"}`
    };
    let doProbe = "skip";
    try {
      if (env.TUNNEL_DO) {
        const id = env.TUNNEL_DO.idFromName("diag");
        const stub = env.TUNNEL_DO.get(id);
        const r = await stub.fetch("https://do/diag");
        doProbe = `${r.status} ${await r.text()}`;
      }
    } catch (e) { doProbe = "ERR " + (e?.message || e); }
    return new Response(JSON.stringify({ flags, doProbe }, null, 2), {
      headers: { "Content-Type": "application/json" }
    });
  }

  // --- DO WS endpoint: /ws/<room> ---
  if (url.pathname.startsWith("/ws/")) {
    if (upgrade !== "websocket") return new Response("Expected Upgrade: websocket", { status: 426 });
    const room = url.pathname.replace("/ws/", "") || "default";
    if (!env.TUNNEL_DO) throw new Error("Binding TUNNEL_DO missing");
    const id = env.TUNNEL_DO.idFromName(room);
    const stub = env.TUNNEL_DO.get(id);
    return stub.fetch(request);
  }

  // --- Lightweight WS tunnel direct: /Free-VPN-OrangLemah/<ip:port> ---
  if (upgrade === "websocket") {
    const m = url.pathname.match(/^\/Free-VPN-OrangLemah\/(.+[:=-]\d+)$/i);
    if (m) return websocketHandler(request, m[1]);
  }

  // --- Routes ---
  if (url.pathname.startsWith("/sub")) return handleSubPage(request, env);

  if (url.pathname.startsWith("/check")) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    const raw = url.searchParams.get("target") || "";
    let ip = "", port = "";
    if (raw.includes(":")) [ip, port] = raw.split(":");
    else if (raw.includes("-")) [ip, port] = raw.split("-");
    ip = (ip || "").trim(); port = (port || "").trim();
    if (!ip || !/^[0-9a-fA-F:.]+$|^[a-zA-Z0-9.-]+$/.test(ip)) return json({ status: "INACTIVE", error: "Invalid IP" }, 400);
    const result = await checkPrxHealth(ip, port || "443", request.cf);
    return json(result);
  }

  if (url.pathname.startsWith("/api/v1")) {
    const p = url.pathname.replace("/api/v1", "");

    // Workers Domains API proxy
    if (p.startsWith("/domains")) {
      const sub = p.replace("/domains", "");
      const api = new CloudflareApi(env);
      if (sub === "/get") {
        const list = await api.getDomainList();
        return json(list);
      }
      if (sub === "/put") {
        const domain = url.searchParams.get("domain");
        const status = await api.registerDomain(domain);
        return new Response(String(status), { status, headers: CORS_HEADERS });
      }
      if (sub.startsWith("/delete")) {
        const domainId = url.searchParams.get("id");
        const password = url.searchParams.get("password") || "";
        if (password !== (env.OWNER_PASSWORD || "")) return new Response("Unauthorized", { status: 401, headers: CORS_HEADERS });
        if (!domainId) return new Response("Domain ID is required", { status: 400, headers: CORS_HEADERS });
        const status = await api.deleteDomain(domainId);
        return new Response(String(status), { status, headers: CORS_HEADERS });
      }
    }

    // Subscription generator
    if (p.startsWith("/sub")) {
      const fillerDomain = url.searchParams.get("domain") || `${env.APP_SERVICE_NAME}.${env.APP_ROOT_DOMAIN}`;
      const effectiveHost = fillerDomain === `${env.APP_SERVICE_NAME}.${env.APP_ROOT_DOMAIN}`
        ? fillerDomain : `${fillerDomain}.${env.APP_SERVICE_NAME}.${env.APP_ROOT_DOMAIN}`;

      const filterCC = (url.searchParams.get("cc")?.split(",") || []).filter(Boolean);
      const filterPort = (url.searchParams.get("port")?.split(",") || PORTS).map(Number);
      const filterVPN  = (url.searchParams.get("vpn")?.split(",") || PROTOCOLS);
      const limit = parseInt(url.searchParams.get("limit") || "10");
      const format = url.searchParams.get("format") || "raw";

      const prxList = await getPrxList(env);
      let work = prxList;
      if (filterCC.length) work = work.filter(p => filterCC.includes(p.country));
      shuffleArray(work);

      const uuid = crypto.randomUUID();
      const out = [];
      for (const prx of work) {
        for (const port of filterPort) {
          for (const vpn of filterVPN) {
            if (out.length >= limit) break;
            const u = new URL(`${vpn}://${fillerDomain}`);
            u.searchParams.set("encryption", "none");
            u.searchParams.set("type", "ws");
            u.searchParams.set("host", effectiveHost);
            u.port = String(port);

            if (vpn === "ss") {
              u.username = btoa(`none:${uuid}`);
              u.searchParams.set("plugin",
                `v2ray-plugin${port === 80 ? "" : ";tls"};mux=0;mode=websocket;path=/Free-VPN-OrangLemah/${prx.prxIP}-${prx.prxPort};host=${effectiveHost}`);
            } else {
              u.username = uuid;
              u.searchParams.delete("plugin");
            }
            u.searchParams.set("security", port === 443 ? "tls" : "none");
            u.searchParams.set("sni", (port === 80 && vpn === "trojan") ? "" : effectiveHost);
            u.searchParams.set("path", `/Free-VPN-oranglemah/${prx.prxIP}-${prx.prxPort}`);
            u.hash = `${out.length + 1} ${getFlagEmoji(prx.country)} ${prx.org} WS ${port === 443 ? "TLS" : "NTLS"} [${env.APP_SERVICE_NAME}]`;
            out.push(u.toString());
          }
        }
      }

      if (format === "raw") return new Response(out.join("\n"), { headers: CORS_HEADERS });
      if (format === "v2ray") return new Response(btoa(out.join("\n")), { headers: CORS_HEADERS });
      if (["clash", "sfa", "bfr"].includes(format)) {
        const r = await fetch(env.CONVERTER_URL, {
          method: "POST",
          body: JSON.stringify({ url: out.join(","), format, template: "cf" })
        });
        if (!r.ok) return new Response(r.statusText, { status: r.status, headers: CORS_HEADERS });
        return new Response(await r.text(), { headers: CORS_HEADERS });
      }
      return new Response(out.join("\n"), { headers: CORS_HEADERS });
    }

    // My IP
    if (p.startsWith("/myip")) {
      return json({
        ip: request.headers.get("cf-connecting-ipv6") ||
            request.headers.get("cf-connecting-ip") ||
            request.headers.get("x-real-ip"),
        colo: request.headers.get("cf-ray")?.split("-")[1],
        ...request.cf,
      });
    }
  }

  // Default landing (bantu cek cepat)
  return new Response(
    "CF DO VPN worker online.\nRoutes:\n" +
    "- /__diag\n- /sub (UI)\n- /check?target=IP:PORT\n- /api/v1/domains/*, /api/v1/sub, /api/v1/myip\n- /ws/<room> (Durable Object WS)\n- /Free-VPN-OrangLemah/<ip:port> (WS tunnel)",
    { headers: { "Content-Type": "text/plain; charset=utf-8" } }
  );
}

/* ================== Durable Object ================== */
export class TunnelDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sessions = new Map();
    this.ctx.getWebSockets().forEach(ws => {
      const att = ws.deserializeAttachment();
      if (att) this.sessions.set(ws, att);
    });
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request) {
    const url = new URL(request.url);
    // HTTP probe for diag
    if (url.pathname === "/diag") return new Response("DO OK", { status: 200 });

    // WebSocket upgrade
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);

    const id = crypto.randomUUID();
    server.serializeAttachment({ id, connectedAt: Date.now() });
    this.sessions.set(server, { id });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, msg) {
    const s = this.sessions.get(ws) || { id: "unknown" };
    this.sessions.forEach((_, other) => {
      try { other.send(`[DO] ${msg} from:${s.id} sessions:${this.sessions.size}`); } catch {}
    });
  }
  async webSocketClose(ws){ this.sessions.delete(ws); }
  async webSocketError(ws){ this.sessions.delete(ws); }
}

/* ================== SUB PAGE (ringkas) ================== */
async function handleSubPage(request, env) {
  const url = new URL(request.url);
  const pageMatch = url.pathname.match(/^\/sub\/(\d+)$/);
  const pageIndex = parseInt(pageMatch ? pageMatch[1] : "0");
  const hostname = url.searchParams.get("host") || `${env.APP_SERVICE_NAME}.${env.APP_ROOT_DOMAIN}`;
  const cc = url.searchParams.get("cc")?.toUpperCase();
  const vpn = url.searchParams.get("vpn") || "all";
  const portSel = url.searchParams.get("port") || "all";
  const search = (url.searchParams.get("search") || "").toLowerCase();

  const all = await getPrxList(env);
  let list = all.filter(prx => {
    if (cc && cc !== "ALL" && prx.country !== cc) return false;
    if (search) {
      const hay = `${prx.prxIP} ${prx.prxPort} ${prx.country} ${prx.org}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  const start = PRX_PER_PAGE * pageIndex;
  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / PRX_PER_PAGE));
  list = list.slice(start, start + PRX_PER_PAGE);

  let rows = "";
  list.forEach((prx, i) => {
    const idx = start + i;
    rows += `
<tr class="hover:bg-gray-100">
  <td class="px-3 py-2 text-center">${idx + 1}</td>
  <td class="px-3 py-2 text-center font-mono">${prx.prxIP}</td>
  <td class="px-3 py-2 text-center">
    <img src="https://hatscripts.github.io/circle-flags/flags/${prx.country.toLowerCase()}.svg" width="20" class="inline mr-1 rounded-full"/>${prx.country}
  </td>
  <td class="px-3 py-2 text-center"><div class="max-w-[150px] overflow-x-auto whitespace-nowrap">${prx.org}</div></td>
  <td id="ping-${idx}" class="px-3 py-2 text-center">${prx.prxIP}:${prx.prxPort}</td>
  <td class="px-3 py-2 text-center">
    <button onclick="copyCfg('${hostname}', '${vpn}', '${portSel}', '${prx.prxIP}', '${prx.prxPort}')" class="px-3 py-1 rounded bg-slate-700 text-white">Config</button>
  </td>
</tr>`;
  });

  const html = `<!DOCTYPE html><html><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Free VLESS/Trojan/SS — ${env.APP_SERVICE_NAME}</title>
<link rel="icon" href="https://geoproject.biz.id/circle-flags/bote.png">
<script src="https://cdn.tailwindcss.com"></script>
<style>.blink{animation:blink 1s linear infinite}@keyframes blink{0%{opacity:1}50%{opacity:.2}100%{opacity:1}}</style>
</head><body class="bg-slate-900 text-slate-100">
<div class="max-w-6xl mx-auto p-4">
  <h1 class="text-2xl font-extrabold mb-2">Free VLESS/TROJAN/SS — ${env.APP_SERVICE_NAME}.${env.APP_ROOT_DOMAIN}</h1>
  <div class="text-sm opacity-80 mb-4">Total: ${total} | Page ${pageIndex + 1}/${totalPages}</div>
  <div class="overflow-x-auto rounded border border-slate-700">
    <table class="min-w-full text-sm">
      <thead class="bg-slate-800">
        <tr><th class="px-3 py-2">No</th><th class="px-3 py-2">IP</th><th class="px-3 py-2">Country</th><th class="px-3 py-2">ISP</th><th class="px-3 py-2">Status</th><th class="px-3 py-2">Action</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <div class="mt-4 flex gap-2">
    <a class="px-3 py-1 rounded bg-blue-600 ${pageIndex===0?"opacity-50 pointer-events-none":""}" href="/sub/${Math.max(0,pageIndex-1)}${url.search?url.search:""}">Prev</a>
    <a class="px-3 py-1 rounded bg-blue-600 ${pageIndex>=totalPages-1?"opacity-50 pointer-events-none":""}" href="/sub/${Math.min(totalPages-1,pageIndex+1)}${url.search?url.search:""}">Next</a>
  </div>
</div>

<script>
const CHECK_URL = "/check?target=";
function copy(text){navigator.clipboard.writeText(text)}
function cfg(host, vpn, portSel, ip, p){
  const ports = portSel==="all"? [443,80] : [Number(portSel)];
  const vpns = vpn==="all"? ${JSON.stringify(PROTOCOLS)} : [vpn];
  const out=[]; const uuid = crypto.randomUUID();
  for(const po of ports){
    for(const v of vpns){
      const u = new URL(v + "://" + host);
      u.port = String(po);
      u.searchParams.set("encryption","none");
      u.searchParams.set("type","ws");
      u.searchParams.set("host",host);
      if(v==="ss"){
        u.username = btoa("none:"+uuid);
        u.searchParams.set("plugin", \`v2ray-plugin\${po===80?"":";tls"};mux=0;mode=websocket;path=/Free-VPN-OrangLemah/\${ip}-\${p};host=\${host}\`);
      } else {
        u.username = uuid; u.searchParams.delete("plugin");
      }
      u.searchParams.set("security", po===443? "tls":"none");
      u.searchParams.set("sni", (po===80 && v==="trojan")? "" : host);
      u.searchParams.set("path", \`/Free-VPN-oranglemah/\${ip}-\${p}\`);
      out.push(u.toString());
    }
  }
  return out.join("\\n");
}
window.copyCfg = (host,vpn,portSel,ip,p)=>copy(cfg(host,vpn,portSel,ip,p));

(function(){
  let i = 0;
  function step(){
    const el = document.getElementById("ping-"+i);
    if(!el) return;
    const target = (el.textContent.split(" ").find(x=>x.includes(":")))||"";
    el.textContent="Checking...";
    fetch(CHECK_URL + encodeURIComponent(target))
      .then(r=>r.json()).then(j=>{
        if(j.status==="ACTIVE"){
          el.innerHTML = '<span class="blink" style="color:#34d399">Active</span><br/><span class="text-xs" style="opacity:.75">'+(j.rtt_ms||"N/A")+'ms ('+(j.colo||"N/A")+')</span>';
        } else {
          el.innerHTML = '<span style="color:#f87171">Inactive</span>';
        }
        i++; step();
      }).catch(_=>{ el.innerHTML = '<span style="color:#f87171">Error</span>'; i++; step(); });
  }
  step();
})();
</script>
</body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/* ================== WS TCP Tunnel ================== */
async function websocketHandler(request, ipPort) {
  const wsPair = new WebSocketPair();
  const [client, server] = Object.values(wsPair);
  server.accept();

  let addressLog = ""; let portLog = "";
  const log = (info, ev) => console.log(`[${addressLog}:${portLog}] ${info}`, ev || "");

  let [addressRemote, portRemote] = ipPort.split(/[:=-]/);
  portRemote = Number(portRemote || "443");

  const early = request.headers.get("sec-websocket-protocol") || "";
  const readable = makeReadableWebSocketStream(server, early, log);
  let remoteSocketWrapper = { value: null };

  readable.pipeTo(new WritableStream({
    async write(chunk){
      if (remoteSocketWrapper.value) {
        const w = remoteSocketWrapper.value.writable.getWriter();
        await w.write(chunk); w.releaseLock(); return;
      }
      await handleTCPOutBound(remoteSocketWrapper, addressRemote, portRemote, chunk, server, null, log);
    },
    close(){ log("readable closed"); },
    abort(r){ log("readable abort", r); }
  })).catch(e => log("pipeTo error", e));

  return new Response(null, { status: 101, webSocket: client });
}

async function handleTCPOutBound(remoteSocketWrapper, addressRemote, portRemote, rawClientData, webSocket, responseHeader, log){
  async function connectAndWrite(address, port){
    const tcp = connect({ hostname: address, port });
    remoteSocketWrapper.value = tcp;
    const w = tcp.writable.getWriter();
    await w.write(rawClientData); w.releaseLock();
    return tcp;
  }
  async function retry(){
    const tcp = await connectAndWrite(addressRemote, portRemote);
    tcp.closed.catch(()=>{}).finally(()=>safeCloseWebSocket(webSocket));
    remoteSocketToWS(tcp, webSocket, responseHeader, null, log);
  }
  const tcp = await connectAndWrite(addressRemote, portRemote);
  remoteSocketToWS(tcp, webSocket, responseHeader, retry, log);
}

async function remoteSocketToWS(remoteSocket, webSocket, responseHeader, retry, log){
  let header = responseHeader;
  let hasIncoming = false;
  await remoteSocket.readable.pipeTo(new WritableStream({
    async write(chunk, controller){
      hasIncoming = true;
      if (webSocket.readyState !== WS_READY_STATE_OPEN) controller.error("ws not open");
      if (header){ webSocket.send(await new Blob([header, chunk]).arrayBuffer()); header = null; }
      else { webSocket.send(chunk); }
    },
    close(){ log("remote.readable closed", { hasIncoming }); },
    abort(r){ console.error("remote.readable abort", r); }
  })).catch(err=>{
    console.error("remoteSocketToWS exception", err?.stack||err);
    safeCloseWebSocket(webSocket);
  });
  if(!hasIncoming && retry) retry();
}

function makeReadableWebSocketStream(wsServer, earlyDataHeader, log){
  let canceled = false;
  const stream = new ReadableStream({
    start(ctrl){
      wsServer.addEventListener("message", ev=>{ if(canceled) return; ctrl.enqueue(ev.data); });
      wsServer.addEventListener("close", ()=>{ safeCloseWebSocket(wsServer); if(!canceled) ctrl.close(); });
      wsServer.addEventListener("error", err=>{ log("ws error"); ctrl.error(err); });
      const { earlyData } = base64ToArrayBuffer(earlyDataHeader);
      if(earlyData) ctrl.enqueue(earlyData);
    },
    cancel(reason){ if(canceled) return; canceled = true; log("ReadableStream cancel", reason); safeCloseWebSocket(wsServer); }
  });
  return stream;
}

function safeCloseWebSocket(socket){
  try {
    if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) socket.close();
  } catch (e) { console.error("safeCloseWebSocket", e); }
}

/* ================== Health Check ================== */
async function checkPrxHealth(prxIP, prxPort, cf) {
  const start = Date.now();
  const port = Number(prxPort || 443);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { status: "INACTIVE", error: "Invalid port", rtt_ms: null, colo: cf?.colo || null };
  }
  const TIMEOUT_MS = 3500;
  const timeoutP = new Promise((_, rej) => {
    const t = setTimeout(() => { clearTimeout(t); rej(new Error("timeout")); }, TIMEOUT_MS);
  });
  try {
    const socket = connect({ hostname: prxIP, port });
    await Promise.race([socket.opened, timeoutP]);
    const rtt = Date.now() - start;
    socket.close().catch(()=>{});
    return { status: "ACTIVE", rtt_ms: rtt, colo: cf?.colo || null };
  } catch (e) {
    return { status: "INACTIVE", error: e?.message || "connect_failed", rtt_ms: null, colo: cf?.colo || null };
  }
}

/* ================== Proxy list cache ================== */
async function refreshProxyList(env) {
  const cache = caches.default;
  const key = new Request("https://cache.local/prx-list");
  const src = env.PRX_BANK_URL;
  if (!src) return;
  const res = await fetch(src);
  if (res.ok) {
    const text = await res.text();
    const data = parsePrxText(text);
    await cache.put(key, new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json", "Cache-Control": "max-age=900" }
    }));
  }
}

function parsePrxText(text) {
  const lines = (text || "").split("\n").filter(Boolean);
  return lines.map(line => {
    const [prxIP, prxPort, country, org] = line.split(",").map(s => (s||"").trim());
    return {
      prxIP: prxIP || "Unknown",
      prxPort: prxPort || "443",
      country: (country || "SG").toUpperCase(),
      org: org || "Unknown Org"
    };
  });
}

async function getPrxList(env) {
  const cache = caches.default;
  const key = new Request("https://cache.local/prx-list");
  let res = await cache.match(key);
  if (res) return await res.json();
  const src = env.PRX_BANK_URL;
  if (!src) return [];
  const r = await fetch(src);
  if (r.ok) {
    const text = await r.text();
    const data = parsePrxText(text);
    await cache.put(key, new Response(JSON.stringify(data), {
      headers: { "Content-Type": "application/json", "Cache-Control": "max-age=900" }
    }));
    return data;
  }
  return [];
}

/* ================== Utils ================== */
function shuffleArray(arr){ let i=arr.length; while(i){ const r=(Math.random()*i--)|0; [arr[i],arr[r]]=[arr[r],arr[i]]; } }
function base64ToArrayBuffer(b64){ if(!b64) return {}; try{ b64=b64.replace(/-/g,"+").replace(/_/g,"/"); const dec=atob(b64); const buf=Uint8Array.from(dec,(c)=>c.charCodeAt(0)); return { earlyData: buf.buffer }; }catch(e){ return { error:e }; } }
function getFlagEmoji(cc){ return cc.toUpperCase().split("").map(ch=>String.fromCodePoint(127397 + ch.charCodeAt(0))).join(""); }
function json(obj, status=200){ return new Response(JSON.stringify(obj), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }); }

/* ================== Cloudflare API (Workers Domains) ================== */
class CloudflareApi {
  constructor(env){
    this.email = env.CF_API_EMAIL;
    this.key = env.CF_GLOBAL_API_KEY;
    this.service = env.APP_SERVICE_NAME;
    this.headers = {
      "Authorization": `Bearer ${this.key}`,
      "X-Auth-Email": this.email,
      "X-Auth-Key": this.key,
      "Content-Type": "application/json",
    };
  }
  async _account(){
    // Ganti ke env.ACCOUNT_ID kalau mau pakai pasti
    return (globalThis.ACCOUNT_ID || "7e6b4320b3200424e6b2ae7ba87e8805");
  }
  async getDomainList(){
    const url = `https://api.cloudflare.com/client/v4/accounts/${await this._account()}/workers/domains`;
    const r = await fetch(url, { headers: this.headers });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.result||[]).filter(d => d.service === this.service).map(d => ({ id: d.id, hostname: d.hostname }));
  }
  async registerDomain(domain){
    try{
      domain = String(domain||"").toLowerCase();
      if (!domain.includes(".")) return 400;
      const exists = (await this.getDomainList()).some(d => d.hostname === domain);
      if (exists) return 409;
      const url = `https://api.cloudflare.com/client/v4/accounts/${await this._account()}/workers/domains`;
      const res = await fetch(url, {
        method: "PUT",
        headers: this.headers,
        body: JSON.stringify({ environment: "production", hostname: domain, service: this.service })
      });
      return res.status;
    } catch(e){ return 400; }
  }
  async deleteDomain(id){
    const url = `https://api.cloudflare.com/client/v4/accounts/${await this._account()}/workers/domains/${id}`;
    const r = await fetch(url, { method:"DELETE", headers: this.headers });
    return r.status;
  }
}
