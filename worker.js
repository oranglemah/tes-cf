import { connect } from "cloudflare:sockets";

/* ================== USER VARS (NON-SECRET) ================== */
// Ini aman kalau tetap di source code / repo
const rootDomain = "oranglemah.web.id";       // Domain utama
const serviceName = "war";                    // Nama Worker
const zoneID = "3de571e998e0b46545df221530b24a1e"; // Zone ID

let isApiReady = false;
let prxIP = "";
let cachedPrxList = [];

/* ================== CONSTANTS ================== */
const WHATSAPP_NUMBER = "0895325108287";
const TELEGRAM_USERNAME = "@Oranglemah97";

const horse = "dHJvamFu"; // trojan
const flash = "dmxlc3M="; // vless
const v2 = "djJyYXk=";    // v2ray
const neko = "Y2xhc2g=";  // clash

const APP_DOMAIN = `${serviceName}.${rootDomain}`;
const PORTS = [443, 80];
const PROTOCOLS = [atob(horse), atob(flash), "ss"];

const PRX_BANK_URL =
  "https://raw.githubusercontent.com/jaka2m/botak/refs/heads/main/cek/proxyList.txt";

const DNS_SERVER_ADDRESS = "8.8.8.8";
const DNS_SERVER_PORT = 53;

const CONVERTER_URL = "https://api.foolvpn.me/convert";
const DONATE_LINK =
  "https://github.com/oranglemah/khusus/raw/main/qris.jpg";

const BAD_WORDS_LIST =
  "https://gist.githubusercontent.com/adierebel/a69396d79b787b84d89b45002cb37cd6/raw/6df5f8728b18699496ad588b3953931078ab9cf1/kata-kasar.txt";

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

const CORS_HEADER_OPTIONS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS,DELETE",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
  "Access-Control-Max-Age": "86400",
};

/* ================== UTILS (DATA) ================== */
async function getKVPrxList(kvPrxUrl) {
  if (!kvPrxUrl) return {};
  const kvPrx = await fetch(kvPrxUrl);
  if (kvPrx.status === 200) return await kvPrx.json();
  return {};
}

async function getPrxList(prxBankUrl = PRX_BANK_URL) {
  // Format:
  // <IP>,<Port>,<Country ID>,<ORG>
  if (!prxBankUrl) throw new Error("No URL Provided!");

  const prxBank = await fetch(prxBankUrl);
  if (prxBank.status === 200) {
    const text = (await prxBank.text()) || "";
    const prxString = text.split("\n").filter(Boolean);
    cachedPrxList = prxString
      .map((entry) => {
        const [prxIP, prxPort, country, org] = entry
          .split(",")
          .map((item) => item.trim());
        return {
          prxIP: prxIP || "Unknown",
          prxPort: prxPort || "Unknown",
          country: country || "Unknown",
          org: org || "Unknown Org",
        };
      })
      .filter(Boolean);
  }

  return cachedPrxList;
}

/* ================== REVERSE PROXY (WEB) ================== */
async function reverseWeb(request, target, targetPath) {
  const targetUrl = new URL(request.url);
  const targetChunk = target.split(":");

  targetUrl.hostname = targetChunk[0];
  targetUrl.port = targetChunk[1]?.toString() || "443";
  targetUrl.pathname = targetPath || targetUrl.pathname;

  const modifiedRequest = new Request(targetUrl, request);
  modifiedRequest.headers.set("X-Forwarded-Host", request.headers.get("Host"));

  const response = await fetch(modifiedRequest);
  const newResponse = new Response(response.body, response);
  for (const [key, value] of Object.entries(CORS_HEADER_OPTIONS)) {
    newResponse.headers.set(key, value);
  }
  newResponse.headers.set("X-Proxied-By", "Cloudflare Worker");

  return newResponse;
}

/* ================== MAIN FETCH ================== */
export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const upgradeHeader = request.headers.get("Upgrade");

      // SECRET dari dashboard:
      const apiToken = env.CLOUDFLARE_API_TOKEN;      // token Cloudflare
      const accountID = env.CLOUDFLARE_ACCOUNT_ID;    // account ID dari secret
      const apiEmail = env.CF_API_EMAIL;              // optional, kalau mau dipakai
      const ownerPassword = env.OWNER_PASSWORD || ""; // password delete wildcard

      // Gateway check (cek secret terisi)
      if (apiToken && accountID && zoneID) {
        isApiReady = true;
      }

      // Handle prx client (WebSocket tunnel)
      if (upgradeHeader === "websocket") {
        const prxMatch = url.pathname.match(
          /^\/Free-VPN-OrangLemah\/(.+[:=-]\d+)$/
        );

        if (url.pathname.length === 3 || url.pathname.match(",")) {
          // Contoh: /ID, /SG, dll
          const prxKeys = url.pathname
            .replace("/", "")
            .toUpperCase()
            .split(",");
          const prxKey = prxKeys[Math.floor(Math.random() * prxKeys.length)];
          const kvPrx = await getKVPrxList(env.KV_PRX_URL);
          prxIP =
            kvPrx[prxKey][Math.floor(Math.random() * kvPrx[prxKey].length)];
          return await websocketHandler(request);
        } else if (prxMatch) {
          prxIP = prxMatch[1];
          return await websocketHandler(request);
        }
      }

      /* ---------- Routes ---------- */

      // Health check proxy: /check?target=IP:PORT atau IP-PORT
      if (url.pathname.startsWith("/check")) {
        // CORS preflight
        if (request.method === "OPTIONS") {
          return new Response(null, {
            status: 204,
            headers: CORS_HEADER_OPTIONS,
          });
        }

        const raw = url.searchParams.get("target") || "";
        let ip = "";
        let port = "";
        if (raw.includes(":")) [ip, port] = raw.split(":");
        else if (raw.includes("-")) [ip, port] = raw.split("-");

        ip = (ip || "").trim();
        port = (port || "").trim();

        if (
          !ip ||
          !/^[0-9a-fA-F:.]+$|^[a-zA-Z0-9.-]+$/.test(ip)
        ) {
          return new Response(
            JSON.stringify({ status: "INACTIVE", error: "Invalid IP" }),
            {
              status: 400,
              headers: {
                ...CORS_HEADER_OPTIONS,
                "Content-Type": "application/json",
              },
            }
          );
        }

        const result = await checkPrxHealth(ip, port || "443", request.cf);
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: {
            ...CORS_HEADER_OPTIONS,
            "Content-Type": "application/json",
          },
        });
      }

      // API v1
      if (url.pathname.startsWith("/api/v1")) {
        const apiPath = url.pathname.replace("/api/v1", "");

        /* -------- Domains (wildcard) ---------- */
        if (apiPath.startsWith("/domains")) {
          if (!isApiReady) {
            return new Response("Api not ready", { status: 500 });
          }

          const wildcardApiPath = apiPath.replace("/domains", "");
          const cloudflareApi = new CloudflareApi({
            apiToken,
            apiEmail,
            accountID,
          });

          if (wildcardApiPath === "/get") {
            const domains = await cloudflareApi.getDomainList();
            return new Response(JSON.stringify(domains), {
              headers: {
                ...CORS_HEADER_OPTIONS,
                "Content-Type": "application/json",
              },
            });
          } else if (wildcardApiPath === "/put") {
            const domain = url.searchParams.get("domain");
            const register = await cloudflareApi.registerDomain(domain);
            return new Response(register.toString(), {
              status: register,
              headers: {
                ...CORS_HEADER_OPTIONS,
                "Content-Type": "text/plain",
              },
            });
          } else if (wildcardApiPath.startsWith("/delete")) {
            const domainId = url.searchParams.get("id");
            const password = url.searchParams.get("password");

            if (password !== ownerPassword) {
              return new Response("Unauthorized", {
                status: 401,
                headers: { ...CORS_HEADER_OPTIONS },
              });
            }
            if (!domainId) {
              return new Response("Domain ID is required", {
                status: 400,
                headers: { ...CORS_HEADER_OPTIONS },
              });
            }

            const result = await cloudflareApi.deleteDomain(domainId);
            return new Response(result.toString(), {
              status: result,
              headers: {
                ...CORS_HEADER_OPTIONS,
                "Content-Type": "text/plain",
              },
            });
          }
        }

        /* -------- Subscription generator ---------- */
        else if (apiPath.startsWith("/sub")) {
          const filterCCParam = url.searchParams.get("cc");
          const filterCC = filterCCParam
            ? filterCCParam
                .split(",")
                .map((x) => x.trim())
                .filter(Boolean)
            : [];

          const filterPortParam = url.searchParams.get("port");
          const filterPort =
            filterPortParam && filterPortParam.trim() !== ""
              ? filterPortParam
                  .split(",")
                  .map((p) => parseInt(p.trim(), 10))
                  .filter((p) => !isNaN(p))
              : PORTS;

          const filterVPNParam = url.searchParams.get("vpn");
          const filterVPN =
            filterVPNParam && filterVPNParam.trim() !== ""
              ? filterVPNParam
                  .split(",")
                  .map((x) => x.trim())
                  .filter(Boolean)
              : PROTOCOLS;

          const filterLimit =
            parseInt(url.searchParams.get("limit") || "10", 10) || 10;
          const filterFormat = url.searchParams.get("format") || "raw";
          const fillerDomain = url.searchParams.get("domain") || APP_DOMAIN;
          const effectiveHost =
            fillerDomain === APP_DOMAIN
              ? APP_DOMAIN
              : `${fillerDomain}.${APP_DOMAIN}`;

          const targetRaw = url.searchParams.get("target") || "";
          const prxBankUrl =
            url.searchParams.get("prx-list") || env.PRX_BANK_URL || PRX_BANK_URL;

          let prxList = await getPrxList(prxBankUrl);

          if (filterCC.length) {
            prxList = prxList.filter((prx) =>
              filterCC.includes(prx.country)
            );
          }

          if (targetRaw) {
            let tIP = "";
            let tPort = "";
            if (targetRaw.includes(":")) [tIP, tPort] = targetRaw.split(":");
            else if (targetRaw.includes("-")) [tIP, tPort] = targetRaw.split("-");
            tIP = (tIP || "").trim();
            tPort = (tPort || "").trim();
            prxList = prxList.filter(
              (p) => p.prxIP === tIP && (!tPort || p.prxPort === tPort)
            );
          }

          shuffleArray(prxList);

          const uuid = crypto.randomUUID();
          const result = [];

          outerLoop: for (const prx of prxList) {
            const __ip = prx.prxIP;
            const __port = prx.prxPort;

            for (const port of filterPort) {
              for (const protocol of filterVPN) {
                if (result.length >= filterLimit) break outerLoop;

                const uri = new URL(`${atob(horse)}://${fillerDomain}`);
                uri.searchParams.set("encryption", "none");
                uri.searchParams.set("type", "ws");
                uri.searchParams.set("host", effectiveHost);

                uri.protocol = protocol;
                uri.port = port.toString();

                if (protocol === "ss") {
                  uri.username = btoa(`none:${uuid}`);
                  uri.searchParams.set(
                    "plugin",
                    `${atob(v2)}-plugin${port === 80 ? "" : ";tls"};mux=0;mode=websocket;path=/Free-VPN-OrangLemah/${__ip}-${__port};host=${effectiveHost}`
                  );
                } else {
                  uri.username = uuid;
                  uri.searchParams.delete("plugin");
                }

                uri.searchParams.set(
                  "security",
                  port === 443 ? "tls" : "none"
                );
                uri.searchParams.set(
                  "sni",
                  port === 80 && protocol === atob(flash)
                    ? ""
                    : effectiveHost
                );
                uri.searchParams.set(
                  "path",
                  `/Free-VPN-OrangLemah/${__ip}-${__port}`
                );

                uri.hash = `${result.length + 1} ${getFlagEmoji(
                  prx.country
                )} ${prx.org} WS ${
                  port === 443 ? "TLS" : "NTLS"
                } [${serviceName}]`;
                result.push(uri.toString());
              }
            }
          }

          let finalResult = "";
          switch (filterFormat) {
            case "raw":
              finalResult = result.join("\n");
              break;
            case atob(v2): // v2ray base64
              finalResult = btoa(result.join("\n"));
              break;
            case atob(neko):
            case "sfa":
            case "bfr": {
              const res = await fetch(CONVERTER_URL, {
                method: "POST",
                body: JSON.stringify({
                  url: result.join(","),
                  format: filterFormat,
                  template: "cf",
                }),
              });
              if (res.status === 200) finalResult = await res.text();
              else {
                return new Response(res.statusText, {
                  status: res.status,
                  headers: {
                    ...CORS_HEADER_OPTIONS,
                    "Content-Type": "text/plain",
                  },
                });
              }
              break;
            }
            default:
              finalResult = result.join("\n");
          }

          return new Response(finalResult, {
            status: 200,
            headers: {
              ...CORS_HEADER_OPTIONS,
              "Content-Type": "text/plain;charset=utf-8",
            },
          });
        }

        /* -------- My IP ---------- */
        else if (apiPath.startsWith("/myip")) {
          return new Response(
            JSON.stringify({
              ip:
                request.headers.get("cf-connecting-ipv6") ||
                request.headers.get("cf-connecting-ip") ||
                request.headers.get("x-real-ip"),
              colo: request.headers.get("cf-ray")?.split("-")[1],
              ...request.cf,
            }),
            {
              headers: {
                ...CORS_HEADER_OPTIONS,
                "Content-Type": "application/json",
              },
            }
          );
        }
      }

      // Default reverse proxy (opsional)
      const targetReversePrx = env.REVERSE_PRX_TARGET || "example.com";
      return await reverseWeb(request, targetReversePrx);
    } catch (err) {
      return new Response(`An error occurred: ${err.toString()}`, {
        status: 500,
        headers: { ...CORS_HEADER_OPTIONS },
      });
    }
  },
};

/* ================== WEBSOCKET HANDLER ================== */
async function websocketHandler(request) {
  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);

  webSocket.accept();

  let addressLog = "";
  let portLog = "";
  const log = (info, event) => {
    console.log(`[${addressLog}:${portLog}] ${info}`, event || "");
  };
  const earlyDataHeader = request.headers.get("sec-websocket-protocol") || "";
  const readableWebSocketStream = makeReadableWebSocketStream(
    webSocket,
    earlyDataHeader,
    log
  );

  let remoteSocketWrapper = { value: null };
  let isDNS = false;

  readableWebSocketStream
    .pipeTo(
      new WritableStream({
        async write(chunk, controller) {
          if (isDNS) {
            return handleUDPOutbound(
              DNS_SERVER_ADDRESS,
              DNS_SERVER_PORT,
              chunk,
              webSocket,
              null,
              log
            );
          }
          if (remoteSocketWrapper.value) {
            const writer = remoteSocketWrapper.value.writable.getWriter();
            await writer.write(chunk);
            writer.releaseLock();
            return;
          }

          const protocol = await protocolSniffer(chunk);
          let protocolHeader;

          if (protocol === atob(horse)) {
            protocolHeader = readHorseHeader(chunk);
          } else if (protocol === atob(flash)) {
            protocolHeader = readFlashHeader(chunk);
          } else {
            protocolHeader = readSsHeader(chunk); // default "ss"
          }

          addressLog = protocolHeader.addressRemote;
          portLog = `${protocolHeader.portRemote} -> ${
            protocolHeader.isUDP ? "UDP" : "TCP"
          }`;

          if (protocolHeader.hasError) throw new Error(protocolHeader.message);

          if (protocolHeader.isUDP) {
            if (protocolHeader.portRemote === 53) {
              isDNS = true;
            } else {
              throw new Error("UDP only support for DNS port 53");
            }
          }

          if (isDNS) {
            return handleUDPOutbound(
              DNS_SERVER_ADDRESS,
              DNS_SERVER_PORT,
              chunk,
              webSocket,
              protocolHeader.version,
              log
            );
          }

          handleTCPOutBound(
            remoteSocketWrapper,
            protocolHeader.addressRemote,
            protocolHeader.portRemote,
            protocolHeader.rawClientData,
            webSocket,
            protocolHeader.version,
            log
          );
        },
        close() {
          log(`readableWebSocketStream is close`);
        },
        abort(reason) {
          log(`readableWebSocketStream is abort`, JSON.stringify(reason));
        },
      })
    )
    .catch((err) => {
      log("readableWebSocketStream pipeTo error", err);
    });

  return new Response(null, { status: 101, webSocket: client });
}

/* ================== PROTOCOL PARSER / STREAM HELPERS ================== */
async function protocolSniffer(buffer) {
  if (buffer.byteLength >= 62) {
    const horseDelimiter = new Uint8Array(buffer.slice(56, 60));
    if (horseDelimiter[0] === 0x0d && horseDelimiter[1] === 0x0a) {
      if (
        [0x01, 0x03, 0x7f].includes(horseDelimiter[2]) &&
        [0x01, 0x03, 0x04].includes(horseDelimiter[3])
      ) {
        return atob(horse);
      }
    }
  }
  const flashDelimiter = new Uint8Array(buffer.slice(1, 17));
  if (
    arrayBufferToHex(flashDelimiter).match(
      /^[0-9a-f]{8}[0-9a-f]{4}4[0-9a-f]{3}[89ab][0-9a-f]{3}[0-9a-f]{12}$/i
    )
  ) {
    return atob(flash);
  }
  return "ss";
}

async function handleTCPOutBound(
  remoteSocket,
  addressRemote,
  portRemote,
  rawClientData,
  webSocket,
  responseHeader,
  log
) {
  async function connectAndWrite(address, port) {
    const tcpSocket = connect({ hostname: address, port });
    remoteSocket.value = tcpSocket;
    log(`connected to ${address}:${port}`);
    const writer = tcpSocket.writable.getWriter();
    await writer.write(rawClientData);
    writer.releaseLock();
    return tcpSocket;
  }

  async function retry() {
    const tcpSocket = await connectAndWrite(
      prxIP.split(/[:=-]/)[0] || addressRemote,
      prxIP.split(/[:=-]/)[1] || portRemote
    );
    tcpSocket.closed
      .catch((error) => console.log("retry tcpSocket closed error", error))
      .finally(() => {
        safeCloseWebSocket(webSocket);
      });
    remoteSocketToWS(tcpSocket, webSocket, responseHeader, null, log);
  }

  const tcpSocket = await connectAndWrite(addressRemote, portRemote);
  remoteSocketToWS(tcpSocket, webSocket, responseHeader, retry, log);
}

async function handleUDPOutbound(
  targetAddress,
  targetPort,
  udpChunk,
  webSocket,
  responseHeader,
  log
) {
  try {
    let protocolHeader = responseHeader;
    const tcpSocket = connect({ hostname: targetAddress, port: targetPort });
    log(`Connected to ${targetAddress}:${targetPort}`);

    const writer = tcpSocket.writable.getWriter();
    await writer.write(udpChunk);
    writer.releaseLock();

    await tcpSocket.readable.pipeTo(
      new WritableStream({
        async write(chunk) {
          if (webSocket.readyState === WS_READY_STATE_OPEN) {
            if (protocolHeader) {
              webSocket.send(
                await new Blob([protocolHeader, chunk]).arrayBuffer()
              );
              protocolHeader = null;
            } else {
              webSocket.send(chunk);
            }
          }
        },
        close() {
          log(`UDP connection to ${targetAddress} closed`);
        },
        abort(reason) {
          console.error(
            `UDP connection to ${targetPort} aborted due to ${reason}`
          );
        },
      })
    );
  } catch (e) {
    console.error(`Error while handling UDP outbound, error ${e.message}`);
  }
}

function makeReadableWebSocketStream(
  webSocketServer,
  earlyDataHeader,
  log
) {
  let readableStreamCancel = false;
  const stream = new ReadableStream({
    start(controller) {
      webSocketServer.addEventListener("message", (event) => {
        if (readableStreamCancel) return;
        controller.enqueue(event.data);
      });
      webSocketServer.addEventListener("close", () => {
        safeCloseWebSocket(webSocketServer);
        if (!readableStreamCancel) controller.close();
      });
      webSocketServer.addEventListener("error", (err) => {
        log("webSocketServer has error");
        controller.error(err);
      });
      const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
      if (error) controller.error(error);
      else if (earlyData) controller.enqueue(earlyData);
    },
    pull() {},
    cancel(reason) {
      if (readableStreamCancel) return;
      log(`ReadableStream was canceled, due to ${reason}`);
      readableStreamCancel = true;
      safeCloseWebSocket(webSocketServer);
    },
  });
  return stream;
}

function readSsHeader(ssBuffer) {
  const view = new DataView(ssBuffer);
  const addressType = view.getUint8(0);
  let addressLength = 0;
  let addressValueIndex = 1;
  let addressValue = "";

  switch (addressType) {
    case 1:
      addressLength = 4;
      addressValue = new Uint8Array(
        ssBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
      ).join(".");
      break;
    case 3:
      addressLength = new Uint8Array(
        ssBuffer.slice(addressValueIndex, addressValueIndex + 1)
      )[0];
      addressValueIndex += 1;
      addressValue = new TextDecoder().decode(
        ssBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
      );
      break;
    case 4:
      addressLength = 16;
      const dataView = new DataView(
        ssBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
      );
      const ipv6 = [];
      for (let i = 0; i < 8; i++) ipv6.push(dataView.getUint16(i * 2).toString(16));
      addressValue = ipv6.join(":");
      break;
    default:
      return { hasError: true, message: `Invalid addressType for SS: ${addressType}` };
  }

  if (!addressValue)
    return {
      hasError: true,
      message: `Destination address empty, address type is: ${addressType}`,
    };

  const portIndex = addressValueIndex + addressLength;
  const portBuffer = ssBuffer.slice(portIndex, portIndex + 2);
  const portRemote = new DataView(portBuffer).getUint16(0);
  return {
    hasError: false,
    addressRemote: addressValue,
    addressType,
    portRemote,
    rawDataIndex: portIndex + 2,
    rawClientData: ssBuffer.slice(portIndex + 2),
    version: null,
    isUDP: portRemote === 53,
  };
}

function readFlashHeader(buffer) {
  const version = new Uint8Array(buffer.slice(0, 1));
  let isUDP = false;

  const optLength = new Uint8Array(buffer.slice(17, 18))[0];
  const cmd = new Uint8Array(buffer.slice(18 + optLength, 18 + optLength + 1))[0];
  if (cmd === 2) isUDP = true;
  else if (cmd !== 1)
    return { hasError: true, message: `command ${cmd} is not supported` };

  const portIndex = 18 + optLength + 1;
  const portBuffer = buffer.slice(portIndex, portIndex + 2);
  const portRemote = new DataView(portBuffer).getUint16(0);

  let addressIndex = portIndex + 2;
  const addressBuffer = new Uint8Array(buffer.slice(addressIndex, addressIndex + 1));

  const addressType = addressBuffer[0];
  let addressLength = 0;
  let addressValueIndex = addressIndex + 1;
  let addressValue = "";
  switch (addressType) {
    case 1:
      addressLength = 4;
      addressValue = new Uint8Array(
        buffer.slice(addressValueIndex, addressValueIndex + addressLength)
      ).join(".");
      break;
    case 2:
      addressLength = new Uint8Array(
        buffer.slice(addressValueIndex, addressValueIndex + 1)
      )[0];
      addressValueIndex += 1;
      addressValue = new TextDecoder().decode(
        buffer.slice(addressValueIndex, addressValueIndex + addressLength)
      );
      break;
    case 3:
      addressLength = 16;
      const dataView = new DataView(
        buffer.slice(addressValueIndex, addressValueIndex + addressLength)
      );
      const ipv6 = [];
      for (let i = 0; i < 8; i++) ipv6.push(dataView.getUint16(i * 2).toString(16));
      addressValue = ipv6.join(":");
      break;
    default:
      return {
        hasError: true,
        message: `invild  addressType is ${addressType}`,
      };
  }
  if (!addressValue)
    return {
      hasError: true,
      message: `addressValue is empty, addressType is ${addressType}`,
    };

  return {
    hasError: false,
    addressRemote: addressValue,
    addressType,
    portRemote,
    rawDataIndex: addressValueIndex + addressLength,
    rawClientData: buffer.slice(addressValueIndex + addressLength),
    version: new Uint8Array([version[0], 0]),
    isUDP,
  };
}

function readHorseHeader(buffer) {
  const dataBuffer = buffer.slice(58);
  if (dataBuffer.byteLength < 6)
    return { hasError: true, message: "invalid request data" };

  let isUDP = false;
  const view = new DataView(dataBuffer);
  const cmd = view.getUint8(0);
  if (cmd === 3) isUDP = true;
  else if (cmd !== 1) throw new Error("Unsupported command type!");

  let addressType = view.getUint8(1);
  let addressLength = 0;
  let addressValueIndex = 2;
  let addressValue = "";
  switch (addressType) {
    case 1:
      addressLength = 4;
      addressValue = new Uint8Array(
        dataBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
      ).join(".");
      break;
    case 3:
      addressLength = new Uint8Array(
        dataBuffer.slice(addressValueIndex, addressValueIndex + 1)
      )[0];
      addressValueIndex += 1;
      addressValue = new TextDecoder().decode(
        dataBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
      );
      break;
    case 4:
      addressLength = 16;
      const dataView = new DataView(
        dataBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
      );
      const ipv6 = [];
      for (let i = 0; i < 8; i++) ipv6.push(dataView.getUint16(i * 2).toString(16));
      addressValue = ipv6.join(":");
      break;
    default:
      return {
        hasError: true,
        message: `invalid addressType is ${addressType}`,
      };
  }

  if (!addressValue)
    return {
      hasError: true,
      message: `address is empty, addressType is ${addressType}`,
    };

  const portIndex = addressValueIndex + addressLength;
  const portBuffer = dataBuffer.slice(portIndex, portIndex + 2);
  const portRemote = new DataView(portBuffer).getUint16(0);
  return {
    hasError: false,
    addressRemote: addressValue,
    addressType,
    portRemote,
    rawDataIndex: portIndex + 4,
    rawClientData: dataBuffer.slice(portIndex + 4),
    version: null,
    isUDP,
  };
}

async function remoteSocketToWS(
  remoteSocket,
  webSocket,
  responseHeader,
  retry,
  log
) {
  let header = responseHeader;
  let hasIncomingData = false;
  await remoteSocket.readable
    .pipeTo(
      new WritableStream({
        start() {},
        async write(chunk, controller) {
          hasIncomingData = true;
          if (webSocket.readyState !== WS_READY_STATE_OPEN)
            controller.error("webSocket.readyState is not open");
          if (header) {
            webSocket.send(await new Blob([header, chunk]).arrayBuffer());
            header = null;
          } else {
            webSocket.send(chunk);
          }
        },
        close() {
          log(
            `remoteConnection!.readable is close with hasIncomingData is ${hasIncomingData}`
          );
        },
        abort(reason) {
          console.error(`remoteConnection!.readable abort`, reason);
        },
      })
    )
    .catch((error) => {
      console.error(`remoteSocketToWS has exception `, error.stack || error);
      safeCloseWebSocket(webSocket);
    });
  if (hasIncomingData === false && retry) {
    log(`retry`);
    retry();
  }
}

function safeCloseWebSocket(socket) {
  try {
    if (
      socket.readyState === WS_READY_STATE_OPEN ||
      socket.readyState === WS_READY_STATE_CLOSING
    ) {
      socket.close();
    }
  } catch (error) {
    console.error("safeCloseWebSocket error", error);
  }
}

/* ================== HEALTH CHECK ================== */
async function checkPrxHealth(prxIP, prxPort, cf) {
  const start = Date.now();

  const port = Number(prxPort || 443);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return {
      status: "INACTIVE",
      error: "Invalid port",
      rtt_ms: null,
      colo: cf?.colo || null,
    };
  }

  const TIMEOUT_MS = 3500;
  const timeoutP = new Promise((_, rej) => {
    const t = setTimeout(() => {
      clearTimeout(t);
      rej(new Error("timeout"));
    }, TIMEOUT_MS);
  });

  try {
    const socket = connect({ hostname: prxIP, port });
    await Promise.race([socket.opened, timeoutP]);
    const rtt = Date.now() - start;
    socket.close().catch(() => {});
    return { status: "ACTIVE", rtt_ms: rtt, colo: cf?.colo || null };
  } catch (e) {
    return {
      status: "INACTIVE",
      error: e?.message || "connect_failed",
      rtt_ms: null,
      colo: cf?.colo || null,
    };
  }
}

/* ================== HELPERS ================== */
function base64ToArrayBuffer(base64Str) {
  if (!base64Str) return { error: null };
  try {
    base64Str = base64Str.replace(/-/g, "+").replace(/_/g, "/");
    const decode = atob(base64Str);
    const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
    return { earlyData: arryBuffer.buffer, error: null };
  } catch (error) {
    return { error };
  }
}

function arrayBufferToHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

function shuffleArray(array) {
  let currentIndex = array.length;
  while (currentIndex !== 0) {
    let randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex--;
    [array[currentIndex], array[randomIndex]] = [
      array[randomIndex],
      array[currentIndex],
    ];
  }
}

function reverse(s) {
  return s.split("").reverse().join("");
}

function getFlagEmoji(isoCode) {
  const codePoints = isoCode
    .toUpperCase()
    .split("")
    .map((char) => 127397 + char.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

/* ================== CLOUDFLARE API ================== */
class CloudflareApi {
  constructor({ apiToken, apiEmail, accountID }) {
    this.apiToken = apiToken;
    this.accountID = accountID;
    this.zoneID = zoneID;
    this.apiEmail = apiEmail;

    // pakai API Token → Authorization: Bearer <token>
    this.headers = {
      Authorization: `Bearer ${this.apiToken}`,
      "Content-Type": "application/json",
    };
  }

  async getDomainList() {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountID}/workers/domains`;
    const res = await fetch(url, { headers: { ...this.headers } });
    if (res.status === 200) {
      const respJson = await res.json();
      return respJson.result
        .filter((data) => data.service === serviceName)
        .map((data) => ({ id: data.id, hostname: data.hostname }));
    }
    return [];
  }

  async registerDomain(domain) {
    domain = (domain || "").toLowerCase();
    const registeredDomains = await this.getDomainList();
    if (!domain.endsWith(rootDomain)) return 400;
    if (registeredDomains.map((d) => d.hostname).includes(domain)) return 409;

    try {
      const domainTest = await fetch(
        `https://${domain.replaceAll("." + APP_DOMAIN, "")}`
      );
      if (domainTest.status === 530) return domainTest.status;

      const badWordsListRes = await fetch(BAD_WORDS_LIST);
      if (badWordsListRes.status === 200) {
        const badWordsList = (await badWordsListRes.text()).split("\n");
        for (const badWord of badWordsList) {
          if (domain.includes(badWord.toLowerCase())) return 403;
        }
      } else {
        return 403;
      }
    } catch (e) {
      return 400;
    }

    const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountID}/workers/domains`;
    const res = await fetch(url, {
      method: "PUT",
      body: JSON.stringify({
        environment: "production",
        hostname: domain,
        service: serviceName,
        zone_id: this.zoneID,
      }),
      headers: { ...this.headers },
    });

    return res.status;
  }

  async deleteDomain(domainId) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountID}/workers/domains/${domainId}`;
    const res = await fetch(url, {
      method: "DELETE",
      headers: { ...this.headers },
    });
    return res.status;
  }
}
