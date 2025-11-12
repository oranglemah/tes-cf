import { connect } from "cloudflare:sockets";
import { DurableObject } from "cloudflare:workers";

/* ================== USER CONFIG VIA ENV ================== */
const PORTS = [443, 80];
const PROTOCOLS = ["vless", "trojan", "ss"]; // UI filter
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
const PRX_PER_PAGE = 24;
const DNS_SERVER_ADDRESS = "8.8.8.8";
const DNS_SERVER_PORT = 53;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const upgradeHeader = request.headers.get("Upgrade");

    // ---------- DO WebSocket endpoint ----------
    if (url.pathname.startsWith("/ws/")) {
      if (upgradeHeader !== "websocket") {
        return new Response("Expected Upgrade: websocket", { status: 426 });
      }
      // Kunci room/instance dari path (/ws/<room>)
      const room = url.pathname.replace("/ws/", "") || "default";
      const id = env.TUNNEL_DO.idFromName(room);
      const stub = env.TUNNEL_DO.get(id);
      return stub.fetch(request);
    }

    // ---------- Reverse proxy default (opsional matikan) ----------
    if (upgradeHeader === "websocket") {
      // WebSocket tunnel ke target khusus /Free-VPN-Geo-Project/<ip-port>
      const prxMatch = url.pathname.match(/^\/Free-VPN-OrangLemah\/(.+[:=-]\d+)$/);
      if (prxMatch) {
        // langsung handle di worker agar low-latency
        const prxIP = prxMatch[1];
        return websocketHandler(request, prxIP);
      }
    }

    // ---------- ROUTES ----------
    if (url.pathname.startsWith("/sub")) {
      return handleSubPage(request, env);
    }

    if (url.pathname.startsWith("/check")) {
      // CORS preflight
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      const raw = url.searchParams.get("target") || "";
      let ip = "", port = "";
      if (raw.includes(":")) [ip, port] = raw.split(":");
      else if (raw.includes("-")) [ip, port] = raw.split("-");
      ip = (ip || "").trim(); port = (port || "").trim();
      if (!ip || !/^[0-9a-fA-F:.]+$|^[a-zA-Z0-9.-]+$/.test(ip)) {
        return json({ status: "INACTIVE", error: "Invalid IP" }, 400);
      }
      const result = await checkPrxHealth(ip, port || "443", request.cf);
      return json(result);
    }

    if (url.pathname.startsWith("/api/v1")) {
      const apiPath = url.pathname.replace("/api/v1", "");
      // ----- Workers Domains API proxy -----
      if (apiPath.startsWith("/domains")) {
        const wildcardPath = apiPath.replace("/domains", "");
        const api = new CloudflareApi(env);
        if (wildcardPath === "/get") {
          const list = await api.getDomainList();
          return json(list);
        } else if (wildcardPath === "/put") {
          const domain = url.searchParams.get("domain");
          const status = await api.registerDomain(domain);
          return new Response(String(status), { status, headers: CORS_HEADERS });
        } else if (wildcardPath.startsWith("/delete")) {
          const domainId = url.searchParams.get("id");
          const password = url.searchParams.get("password") || "";
          if (password !== (env.OWNER_PASSWORD || "")) {
            return new Response("Unauthorized", { status: 401, headers: CORS_HEADERS });
          }
          if (!domainId) return new Response("Domain ID is required", { status: 400, headers: CORS_HEADERS });
          const status = await api.deleteDomain(domainId);
          return new Response(String(status), { status, headers: CORS_HEADERS });
        }
      }
      // ----- subscription generator -----
      if (apiPath.startsWith("/sub")) {
        const fillerDomain = url.searchParams.get("domain") || `${env.APP_SERVICE_NAME}.${env.APP_ROOT_DOMAIN}`;
        const effectiveHost = fillerDomain === `${env.APP_SERVICE_NAME}.${env.APP_ROOT_DOMAIN}`
          ? fillerDomain
          : `${fillerDomain}.${env.APP_SERVICE_NAME}.${env.APP_ROOT_DOMAIN}`;

        const filterCC = (url.searchParams.get("cc")?.split(",") || []).filter(Boolean);
        const filterPort = (url.searchParams.get("port")?.split(",") || PORTS).map(Number);
        const filterVPN  = (url.searchParams.get("vpn")?.split(",") || PROTOCOLS);
        const limit = parseInt(url.searchParams.get("limit") || "10");
        const format = url.searchParams.get("format") || "raw";

        const prxList = await getPrxList(env);

        // filter & shuffle
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
              u.searchParams.set("sni", port === 80 && vpn === "trojan" ? "" : effectiveHost);
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

      // ----- myip -----
      if (apiPath.startsWith("/myip")) {
        return json({
          ip: request.headers.get("cf-connecting-ipv6") ||
              request.headers.get("cf-connecting-ip") ||
              request.headers.get("x-real-ip"),
          colo: request.headers.get("cf-ray")?.split("-")[1],
          ...request.cf,
        });
      }
    }

    // Default: halaman bantuan
    return new Response("CF DO VPN worker online.\nRoutes: /sub, /check?target=IP:PORT, /api/v1/*, /ws/<room>", {
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  },

  // Cron: refresh cache proxy list
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(refreshProxyList(env));
  },
};

/* ================== Durable Object: TunnelDO ================== */
export class TunnelDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sessions = new Map();

    // Re-attach hibernating websockets
    this.ctx.getWebSockets().forEach(ws => {
      const att = ws.deserializeAttachment();
      if (att) this.sessions.set(ws, att);
    });

    // Example auto response (ping/pong) tidak membangunkan DO
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request) {
    // Accept upgrade & hibernate
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
    // broadcast sederhana
    this.sessions.forEach((_, other) => {
      try { other.send(`[DO] message: ${msg}, from: ${s.id}, total: ${this.sessions.size}`); } catch {}
    });
  }

  async webSocketClose(ws, code, reason, wasClean) {
    this.sessions.delete(ws);
  }

  async webSocketError(ws, err) {
    this.sessions.delete(ws);
  }
}

/* ================== Page/UI (ringkas): generate tabel dari PRX cache ================== */
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

  // Build rows
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
  const out=[];
  const uuid = crypto.randomUUID();
  for(const po of ports){
    for(const v of vpns){
      const u = new URL(v + "://" + host);
      u.port = String(po);
      u.searchParams.set("encryption","none");
      u.searchParams.set("type","ws");
      u.searchParams.set("host",host);
      if(v==="ss"){
        u.username = btoa("none:"+uuid);
        u.searchParams.set("plugin", \`v2ray-plugin\${po===80?"":";tls"};mux=0;mode=websocket;path=/Free-VPN-Geo-Project/\${ip}-\${p};host=\${host}\`);
      } else {
        u.username = uuid;
        u.searchParams.delete("plugin");
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

// ping/health loop
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
          el.innerHTML = '<span class="blink text-green-400">Active</span><br/><span class="text-xs opacity-70">'+(j.rtt_ms||"N/A")+'ms ('+(j.colo||"N/A")+')</span>';
        } else {
          el.innerHTML = '<span class="text-red-400">Inactive</span>';
        }
        i++; step();
      }).catch(_=>{
        el.innerHTML = '<span class="text-red-400">Error</span>'; i++; step();
      });
  }
  step();
})();
</script>
</body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/* ================== WebSocket TCP tunnel (Worker side) ================== */
async function websocketHandler(request, prxIPPort) {
  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);
  webSocket.accept();

  let addressLog = "";
  let portLog = "";
  const log = (info, event) => console.log(`[${addressLog}:${portLog}] ${info}`, event || "");

  // parse target ip:port
  let [addressRemote, portRemote] = prxIPPort.split(/[:=-]/);
  portRemote = Number(portRemote || "443");

  // simple pump: pertama data dari client → target
  const earlyDataHeader = request.headers.get("sec-websocket-protocol") || "";
  const readable = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);
  let remoteSocketWrapper = { value: null };

  readable.pipeTo(new WritableStream({
    async write(chunk) {
      if (remoteSocketWrapper.value) {
        const w = remoteSocketWrapper.value.writable.getWriter();
        await w.write(chunk); w.releaseLock(); return;
      }
      // connect pertama kali
      await handleTCPOutBound(remoteSocketWrapper, addressRemote, portRemote, chunk, webSocket, null, log);
    },
    close(){ log("readableWebSocketStream closed"); },
    abort(r){ log("readableWebSocketStream abort", r); }
  })).catch(e=>log("pipeTo error", e));

  return new Response(null, { status: 101, webSocket: client });
}

/* ================== TCP helpers ================== */
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
      wsServer.addEventListener("message", ev=>{
        if(canceled) return; ctrl.enqueue(ev.data);
      });
      wsServer.addEventListener("close", ()=>{
        safeCloseWebSocket(wsServer);
        if(!canceled) ctrl.close();
      });
      wsServer.addEventListener("error", err=>{
        log("ws error"); ctrl.error(err);
      });
      const { earlyData } = base64ToArrayBuffer(earlyDataHeader);
      if(earlyData) ctrl.enqueue(earlyData);
    },
    cancel(reason){ if(canceled) return; canceled = true; log("ReadableStream cancel", reason); safeCloseWebSocket(wsServer); }
  });
  return stream;
}

function safeCloseWebSocket(socket){
  try{
    if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) socket.close();
  } catch (e) { console.error("safeCloseWebSocket", e); }
}

/* ================== Health check via TCP ================== */
async function checkPrxHealth(prxIP, prxPort, cf) {
  const start = Date.now();
  const port = Number(prxPort || 443);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { status: "INACTIVE", error: "Invalid port", rtt_ms: null, colo: cf?.colo || null };
  }
  const TIMEOUT_MS = 3500;
  const timeoutP = new Promise((_, rej)=>{
    const t = setTimeout(()=>{ clearTimeout(t); rej(new Error("timeout")); }, TIMEOUT_MS);
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
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS,DELETE",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
  "Access-Control-Max-Age": "86400",
};

async function refreshProxyList(env) {
  const cache = caches.default;
  const key = new Request("https://cache.local/prx-list");
  const res = await fetch(env.PRX_BANK_URL);
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

  // first time (or cache miss)
  const r = await fetch(env.PRX_BANK_URL);
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
function base64ToArrayBuffer(b64){ if(!b64) return { }; try{ b64=b64.replace(/-/g,"+").replace(/_/g,"/"); const dec=atob(b64); const buf=Uint8Array.from(dec,(c)=>c.charCodeAt(0)); return { earlyData: buf.buffer }; }catch(e){ return { error:e }; } }
function getFlagEmoji(cc){ return cc.toUpperCase().split("").map(ch=>String.fromCodePoint(127397 + ch.charCodeAt(0))).join(""); }
function json(obj, status=200){ return new Response(JSON.stringify(obj), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }); }

/* ================== Cloudflare API (Domains) ================== */
class CloudflareApi {
  constructor(env){
    this.accountID = "7e6b4320b3200424e6b2ae7ba87e8805"; // optional: tidak wajib buat workers.domains (pakai account-level)
    this.zoneID = "3de571e998e0b46545df221530b24a1e";    // untuk attach by zone, tapi API `/workers/domains` cukup account-level.
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

  async _account(){
    // tip: kalau perlu, ambil dari headers JWT; untuk sederhana, minta user isi manual (opsional).
    // biarkan kosong → user bisa ganti ke env.ACCOUNT_ID dan pakai itu.
    return (globalThis.ACCOUNT_ID || "7e6b4320b3200424e6b2ae7ba87e8805"); // atau set manual di kode kalau mau
  }
}
