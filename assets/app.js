// ================== KONFIG FRONTEND ==================
const ROOT_DOMAIN = "sambat.nailamazy.biz.id"; // <- ganti kalau Worker beda
const CHECK_PROXY_URL_BASE = `https://${ROOT_DOMAIN}/check?target=`;
const MYIP_URL = `https://${ROOT_DOMAIN}/api/v1/myip`;
const DOMAINS_GET_URL = `https://${ROOT_DOMAIN}/api/v1/domains/get`;
const DOMAINS_PUT_URL = `https://${ROOT_DOMAIN}/api/v1/domains/put`;
const DOMAINS_DELETE_URL = `https://${ROOT_DOMAIN}/api/v1/domains/delete`;
const CONVERTER_URL = "https://api.foolvpn.me/convert";
const PRX_BANK_URL = "https://raw.githubusercontent.com/jaka2m/botak/refs/heads/main/cek/proxyList.txt";

const PORTS = [443, 80];
const horse = "dHJvamFu"; // trojan
const flash = "dmxlc3M="; // vless
const v2 = "djJyYXk=";    // v2ray-plugin
const neko = "Y2xhc2g=";  // clash
const PROTOCOLS = [atob(horse), atob(flash), "ss"];
const APP_DOMAIN = ROOT_DOMAIN; // Untuk host default

// state
let rawConfig = "";
let wildcardDomains = [];
let cachedProxies = [];      // { prxIP, prxPort, country, org }
let filteredProxies = [];
let currentPage = 1;
const PRX_PER_PAGE = 24;

// ================== DOM HELPER ==================
const $ = (id) => document.getElementById(id);

// ================== RUNNING TITLE ==================
function initRunningTitle() {
  const runningTitle = $("runningTitle");
  if (!runningTitle) return;
  const container = runningTitle.parentElement;
  let position = -runningTitle.offsetWidth;
  const speed = 1.5;

  function animateTitle() {
    position += speed;
    if (position > container.offsetWidth) {
      position = -runningTitle.offsetWidth;
    }
    runningTitle.style.transform = `translateX(${position}px)`;
    requestAnimationFrame(animateTitle);
  }

  animateTitle();
}

// ================== LOADING SCREEN ==================
function initLoadingScreen() {
  const loadingScreen = $("loading-screen");
  if (!loadingScreen) return;
  setTimeout(() => {
    loadingScreen.style.opacity = "0";
    setTimeout(() => {
      loadingScreen.style.display = "none";
    }, 500);
  }, 1000);
}

// ================== THEME & FLOATING MENU ==================
function initDarkModeToggle() {
  const btnDark = $("btn-dark-toggle");
  if (!btnDark) return;
  btnDark.addEventListener("click", () => {
    const root = $("html");
    if (root.classList.contains("dark")) {
      root.classList.remove("dark");
      localStorage.setItem("theme", "light");
    } else {
      root.classList.add("dark");
      localStorage.setItem("theme", "dark");
    }
  });
}

function initDropdownMenu() {
  const btn = $("btn-main-dropdown");
  const menu = $("dropdown-menu");
  if (!btn || !menu) return;
  btn.addEventListener("click", () => {
    menu.classList.toggle("hidden");
  });
}

// ================== WILDCARDS WINDOW ==================
function toggleWindow() {
  const windowContainer = $("container-window");
  if (!windowContainer) return;
  windowContainer.classList.toggle("hidden");
}

function toggleOutputWindow() {
  const windowInfo = $("container-window-info");
  const outputWindow = $("output-window");
  if (!windowInfo || !outputWindow) return;

  windowInfo.innerText = "Select output:";
  toggleWindow();
  outputWindow.classList.toggle("hidden");
}

function toggleWildcardsWindow() {
  const windowInfo = $("container-window-info");
  const wildWindow = $("wildcards-window");
  if (!windowInfo || !wildWindow) return;
  windowInfo.innerText = "Domain list";
  toggleWindow();
  wildWindow.classList.toggle("hidden");
  if (!wildWindow.classList.contains("hidden")) {
    getDomainList();
  }
}

// ================== DOMAINS API (WILDCARD) ==================
function getDomainList() {
  const windowInfo = $("container-window-info");
  const domainListContainer = $("container-domains");
  if (!windowInfo || !domainListContainer) return;

  windowInfo.innerText = "Fetching data...";
  fetch(DOMAINS_GET_URL)
    .then((res) => res.json())
    .then((respJson) => {
      wildcardDomains = respJson || [];
      domainListContainer.innerHTML = "";
      wildcardDomains.forEach((domain, index) => {
        const row = document.createElement("div");
        row.className = "flex items-center justify-between w-full rounded-md p-2 text-white";
        const text = document.createElement("span");
        text.innerText = `${index + 1}. ${domain.hostname}`;
        row.appendChild(text);
        domainListContainer.appendChild(row);
      });
      windowInfo.innerText = "Done!";
    })
    .catch(() => {
      windowInfo.innerText = "Failed!";
    });
}

function deleteDomain(domainId, domainName) {
  Swal.fire({
    title: "Masukkan Password",
    text: "Untuk menghapus domain: " + domainName,
    input: "password",
    inputPlaceholder: "Password...",
    showCancelButton: true,
    confirmButtonText: "Hapus",
    cancelButtonText: "Batal",
    width: "300px",
    showLoaderOnConfirm: true,
    preConfirm: (password) => {
      if (!password) {
        Swal.showValidationMessage("Password tidak boleh kosong");
        return false;
      }
      const url =
        `${DOMAINS_DELETE_URL}?id=${encodeURIComponent(domainId)}&password=${encodeURIComponent(password)}`;
      return fetch(url, { method: "DELETE" })
        .then((response) => {
          if (!response.ok) {
            if (response.status === 401) throw new Error("Password salah!");
            throw new Error("Gagal! Status: " + response.status);
          }
          return response.json().catch(() => ({}));
        })
        .catch((error) => {
          Swal.showValidationMessage(error.message);
          return false;
        });
    },
    allowOutsideClick: () => !Swal.isLoading(),
  }).then((result) => {
    if (result.isConfirmed) {
      Swal.fire({
        title: "Berhasil!",
        text: "Domain telah dihapus.",
        icon: "success",
        width: "300px",
        timer: 1500,
        showConfirmButton: false,
      });
      getDomainList();
    }
  });
}

function deleteDomainByNumber() {
  const inputElement = $("delete-domain-input");
  if (!inputElement) return;

  const number = parseInt(inputElement.value, 10);
  if (isNaN(number) || number < 1 || number > wildcardDomains.length) {
    Swal.fire({
      title: "Error",
      text: "Masukkan nomor urut yang valid.",
      icon: "error",
      width: "300px",
      timer: 1500,
      showConfirmButton: false,
    });
    return;
  }
  const domainToDelete = wildcardDomains[number - 1];
  deleteDomain(domainToDelete.id, domainToDelete.hostname);
  inputElement.value = "";
}

function registerDomain() {
  const domainInputElement = $("new-domain-input");
  const windowInfo = $("container-window-info");
  if (!domainInputElement || !windowInfo) return;

  const rawDomain = domainInputElement.value.toLowerCase();
  const domain = `${rawDomain}.${ROOT_DOMAIN}`;
  if (!rawDomain.match(/\w+\.\w+$/) || rawDomain.endsWith(ROOT_DOMAIN)) {
    windowInfo.innerText = "Invalid URL!";
    return;
  }
  windowInfo.innerText = "Pushing request...";
  const url = `${DOMAINS_PUT_URL}?domain=${encodeURIComponent(domain)}`;
  fetch(url).then((res) => {
    if (res.status == 200) {
      windowInfo.innerText = "Done!";
      domainInputElement.value = "";
      getDomainList();
    } else {
      windowInfo.innerText = res.status == 409 ? "Domain exists!" : "Error " + res.status;
    }
  });
}

// ================== IP INFO ==================
function initMyIP() {
  fetch(MYIP_URL)
    .then((res) => res.json())
    .then((d) => {
      const ipEl = $("container-info-ip");
      const countryEl = $("container-info-country");
      const ispEl = $("container-info-isp");
      if (ipEl) ipEl.innerText = `IP: ${d.ip || ""}`;
      if (countryEl) countryEl.innerText = `Country: ${d.country || ""}`;
      if (ispEl) ispEl.innerText = `ISP: ${d.asOrganization || ""}`;
    })
    .catch(() => {});
}

// ================== NOTIF COPY ==================
function showCopiedNotif() {
  const notification = $("notification-badge");
  if (!notification) return;
  notification.classList.remove("opacity-0");
  setTimeout(() => notification.classList.add("opacity-0"), 2000);
}

// ================== COPY CONFIG ==================
function copyToClipboard(text) {
  rawConfig = text;
  toggleOutputWindow();
}

function copyToClipboardAsRaw() {
  if (!rawConfig) return;
  navigator.clipboard.writeText(rawConfig).then(showCopiedNotif);
}

async function copyToClipboardAsTarget(target) {
  const windowInfo = $("container-window-info");
  if (!windowInfo) return;

  windowInfo.innerText = "Generating config...";
  try {
    const res = await fetch(CONVERTER_URL, {
      method: "POST",
      body: JSON.stringify({ url: rawConfig, format: target, template: "cf" }),
    });
    if (res.status === 200) {
      windowInfo.innerText = "Done!";
      const text = await res.text();
      await navigator.clipboard.writeText(text);
      showCopiedNotif();
    } else {
      windowInfo.innerText = "Error " + res.statusText;
    }
  } catch (e) {
    windowInfo.innerText = "Error";
  }
}

// ================== WAKTU ==================
function updateTime() {
  const timeElement = $("time-info-value");
  if (!timeElement) return;
  const now = new Date();
  timeElement.textContent = now.toLocaleTimeString("en-GB");
}

// ================== PROXY LIST HANDLING ==================
async function fetchProxyList() {
  const res = await fetch(PRX_BANK_URL);
  if (!res.ok) throw new Error("Failed to fetch proxy list");
  const text = await res.text();
  const lines = text.split("\n").filter(Boolean);
  cachedProxies = lines.map((line) => {
    const [prxIP, prxPort, country, org] = line.split(",").map((s) => (s || "").trim());
    return {
      prxIP: prxIP || "Unknown",
      prxPort: prxPort || "Unknown",
      country: country || "Unknown",
      org: org || "Unknown Org",
    };
  });
}

function populateCountryDropdown() {
  const select = $("country-select");
  if (!select) return;
  const uniqueCountries = Array.from(new Set(cachedProxies.map((p) => p.country))).sort();
  select.innerHTML = "";
  const optAll = document.createElement("option");
  optAll.value = "all";
  optAll.textContent = "All Countries";
  select.appendChild(optAll);
  uniqueCountries.forEach((country) => {
    const opt = document.createElement("option");
    opt.value = country;
    opt.textContent = `${getFlagEmoji(country)} ${country}`;
    select.appendChild(opt);
  });
}

function populateHostDropdown() {
  const select = $("host-select");
  if (!select) return;
  const hosts = [
    { value: APP_DOMAIN, label: `Default Host (${APP_DOMAIN})` },
    { value: "ava.game.naver.com", label: "ava.game.naver.com" },
    { value: "support.zoom.us", label: "support.zoom.us" },
    { value: "api.midtrans.com", label: "api.midtrans.com" },
    { value: "collection.linefriends.com", label: "collection.linefriends.com" },
  ];
  select.innerHTML = "";
  hosts.forEach((host) => {
    const opt = document.createElement("option");
    opt.value = host.value;
    opt.textContent = host.label;
    select.appendChild(opt);
  });
}

function applyFiltersAndRender(resetPage = false) {
  if (resetPage) currentPage = 1;

  const protocol = $("protocol-select")?.value || "all";
  const country = $("country-select")?.value || "all";
  const host = $("host-select")?.value || APP_DOMAIN;
  const portFilter = $("port-select")?.value || "all";
  const search = $("search-bar")?.value.trim().toLowerCase() || "";

  filteredProxies = cachedProxies.filter((p) => {
    if (country !== "all" && p.country !== country) return false;
    if (search) {
      const s = search;
      const combined = `${p.prxIP} ${p.prxPort} ${p.country} ${p.org}`.toLowerCase();
      if (!combined.includes(s)) return false;
    }
    return true;
  });

  $("total-proxy-value").textContent = filteredProxies.length.toString();

  const totalPages = Math.max(1, Math.ceil(filteredProxies.length / PRX_PER_PAGE));
  if (currentPage > totalPages) currentPage = totalPages;
  $("page-info-value").textContent = `${currentPage}/${totalPages}`;

  renderProxyTable();
  renderPagination(totalPages);
}

function renderProxyTable() {
  const tbody = $("proxy-tbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  const startIndex = (currentPage - 1) * PRX_PER_PAGE;
  const endIndex = Math.min(startIndex + PRX_PER_PAGE, filteredProxies.length);
  for (let i = startIndex; i < endIndex; i++) {
    const prx = filteredProxies[i];
    if (!prx) continue;

    const tr = document.createElement("tr");
    tr.className = "hover:bg-gray-100 dark:hover:bg-gray-700";

    const idxTd = document.createElement("td");
    idxTd.className = "px-3 py-3 text-base text-gray-500 dark:text-gray-400 text-center";
    idxTd.textContent = (i + 1).toString();

    const ipTd = document.createElement("td");
    ipTd.className = "px-3 py-3 text-base font-mono text-center text-gray-800 dark:text-gray-200";
    ipTd.textContent = prx.prxIP;

    const countryTd = document.createElement("td");
    countryTd.className =
      "px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-300 flex items-center justify-center";
    const img = document.createElement("img");
    img.src = `https://hatscripts.github.io/circle-flags/flags/${prx.country.toLowerCase()}.svg`;
    img.width = 20;
    img.className = "inline mr-2 rounded-full";
    countryTd.appendChild(img);
    countryTd.appendChild(document.createTextNode(prx.country));

    const orgTd = document.createElement("td");
    orgTd.className = "px-3 py-3 text-base font-mono text-center text-gray-800 dark:text-gray-200";
    const orgDiv = document.createElement("div");
    orgDiv.className = "max-w-[150px] overflow-x-auto whitespace-nowrap";
    orgDiv.textContent = prx.org;
    orgTd.appendChild(orgDiv);

    const statusTd = document.createElement("td");
    statusTd.id = `ping-${i - startIndex}`; // local index for current page
    statusTd.className = "px-6 py-4 whitespace-nowrap text-sm text-gray-700 dark:text-white text-center";
    statusTd.textContent = `${prx.prxIP}:${prx.prxPort}`;

    const actionTd = document.createElement("td");
    actionTd.className = "px-6 py-4 whitespace-nowrap text-sm font-medium text-center";
    const btn = document.createElement("button");
    btn.className = "text-white px-4 py-1 rounded text-sm font-semibold action-btn";
    btn.textContent = "Config";
    btn.addEventListener("click", () => {
      const host = $("host-select")?.value || APP_DOMAIN;
      const portFilter = $("port-select")?.value || "all";
      const protocolFilter = $("protocol-select")?.value || "all";
      const cfgs = buildProxyConfigsForSingle(prx, host, portFilter, protocolFilter);
      copyToClipboard(cfgs.join(","));
    });
    actionTd.appendChild(btn);

    tr.appendChild(idxTd);
    tr.appendChild(ipTd);
    tr.appendChild(countryTd);
    tr.appendChild(orgTd);
    tr.appendChild(statusTd);
    tr.appendChild(actionTd);
    tbody.appendChild(tr);
  }

  // Setelah render, cek status proxy pada page ini
  setTimeout(checkProxyForCurrentPage, 100);
}

function renderPagination(totalPages) {
  const container = $("pagination-buttons");
  const info = $("pagination-info");
  if (!container || !info) return;

  container.innerHTML = "";

  const prevBtn = document.createElement("button");
  prevBtn.textContent = "Prev";
  prevBtn.className =
    "px-6 py-2 text-white rounded-lg disabled:opacity-50 text-base font-semibold btn-gradient hover:opacity-80";
  prevBtn.disabled = currentPage <= 1;
  prevBtn.addEventListener("click", () => {
    if (currentPage > 1) {
      currentPage--;
      applyFiltersAndRender(false);
    }
  });

  const nextBtn = document.createElement("button");
  nextBtn.textContent = "Next";
  nextBtn.className =
    "px-6 py-2 text-white rounded-lg disabled:opacity-50 text-base font-semibold btn-gradient hover:opacity-80";
  nextBtn.disabled = currentPage >= totalPages;
  nextBtn.addEventListener("click", () => {
    if (currentPage < totalPages) {
      currentPage++;
      applyFiltersAndRender(false);
    }
  });

  const liPrev = document.createElement("li");
  liPrev.appendChild(prevBtn);
  const liNext = document.createElement("li");
  liNext.appendChild(nextBtn);
  container.appendChild(liPrev);
  container.appendChild(liNext);

  const total = filteredProxies.length;
  const from = total === 0 ? 0 : (currentPage - 1) * PRX_PER_PAGE + 1;
  const to = Math.min(currentPage * PRX_PER_PAGE, total);
  info.textContent = `Showing ${from} to ${to} of ${total} Proxies`;
}

// ================== HEALTH CHECK (CLIENT SIDE CALL KE WORKER) ==================
function checkProxyForCurrentPage() {
  for (let i = 0; ; i++) {
    const pingElement = $("ping-" + i);
    if (!pingElement) return;

    const text = pingElement.textContent || "";
    const target = (text.split(" ").find((x) => x.includes(":"))) || text;
    if (!target) continue;

    pingElement.textContent = "Checking...";
    pingElement.classList.remove("text-green-600", "text-red-600");

    fetch(CHECK_PROXY_URL_BASE + encodeURIComponent(target))
      .then((res) => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then((json) => {
        if (json.status === "ACTIVE") {
          const delay = typeof json.rtt_ms === "number" ? json.rtt_ms + "ms" : "N/A";
          const colo = json.colo || "N/A";
          pingElement.innerHTML =
            `<span class="blink-text">Active</span><br><span class="text-xs font-normal text-yellow-400">${delay} (${colo})</span>`;
          pingElement.classList.add("text-green-600");
        } else {
          const err = json.error ? " — " + json.error : "";
          pingElement.textContent = "Inactive" + err;
          pingElement.classList.add("text-red-600");
        }
      })
      .catch(() => {
        pingElement.textContent = "Fetch Error!";
        pingElement.classList.add("text-red-600");
      });
  }
}

// ================== BUILD CONFIG (MIRROR KODE WORKER) ==================
function getFlagEmoji(isoCode) {
  const codePoints = isoCode
    .toUpperCase()
    .split("")
    .map((char) => 127397 + char.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

function buildProxyConfigsForSingle(prx, fillerDomain, portFilter, protocolFilter) {
  const result = [];
  const uuid = crypto.randomUUID();
  const effectiveHost = fillerDomain === APP_DOMAIN ? APP_DOMAIN : `${fillerDomain}.${APP_DOMAIN}`;
  const filterPorts =
    portFilter === "all" ? PORTS : PORTS.filter((p) => p.toString() === portFilter);
  const filterProtocols =
    protocolFilter === "all" ? PROTOCOLS : PROTOCOLS.filter((p) => p === protocolFilter);

  for (const port of filterPorts) {
    const uri = new URL(`${atob(horse)}://${fillerDomain}`);
    uri.searchParams.set("encryption", "none");
    uri.searchParams.set("type", "ws");
    uri.searchParams.set("host", effectiveHost);

    for (const protocol of filterProtocols) {
      uri.protocol = protocol;
      uri.port = port.toString();

      const __ip = prx.prxIP;
      const __port = prx.prxPort;

      if (protocol === "ss") {
        uri.username = btoa(`none:${uuid}`);
        uri.searchParams.set(
          "plugin",
          `${atob(v2)}-plugin${port == 80 ? "" : ";tls"};mux=0;mode=websocket;path=/Free-VPN-OrangLemah/${__ip}-${__port};host=${effectiveHost}`
        );
      } else {
        uri.username = uuid;
        uri.searchParams.delete("plugin");
      }

      uri.searchParams.set("security", port == 443 ? "tls" : "none");
      uri.searchParams.set(
        "sni",
        port == 80 && protocol == atob(flash) ? "" : effectiveHost
      );
      uri.searchParams.set("path", `/Free-VPN-orangLemah/${__ip}-${__port}`);
      uri.hash = `${result.length + 1} ${getFlagEmoji(prx.country)} ${prx.org} WS ${
        port == 443 ? "TLS" : "NTLS"
      } [sambat]`;

      result.push(uri.toString());
    }
  }

  return result;
}

// ================== INIT ==================
document.addEventListener("DOMContentLoaded", async () => {
  initLoadingScreen();
  initRunningTitle();
  initDarkModeToggle();
  initDropdownMenu();

  // tombol overlay & wildcard
  $("btn-output-close")?.addEventListener("click", toggleOutputWindow);
  $("btn-wildcard-close")?.addEventListener("click", toggleWildcardsWindow);
  $("btn-wildcards-toggle")?.addEventListener("click", toggleWildcardsWindow);
  $("btn-register-domain")?.addEventListener("click", registerDomain);
  $("btn-delete-domain-number")?.addEventListener("click", deleteDomainByNumber);

  $("btn-search")?.addEventListener("click", () => applyFiltersAndRender(true));
  $("search-bar")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") applyFiltersAndRender(true);
  });

  $("protocol-select")?.addEventListener("change", () => applyFiltersAndRender(true));
  $("country-select")?.addEventListener("change", () => applyFiltersAndRender(true));
  $("host-select")?.addEventListener("change", () => applyFiltersAndRender(false));
  $("port-select")?.addEventListener("change", () => applyFiltersAndRender(true));

  $("btn-copy-raw")?.addEventListener("click", copyToClipboardAsRaw);
  document.querySelectorAll(".btn-copy-format").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.getAttribute("data-target");
      if (target) copyToClipboardAsTarget(target);
    });
  });

  // waktu
  updateTime();
  setInterval(updateTime, 1000);

  // lozad
  const observer = lozad(".lozad", {
    load: function (el) {
      el.classList.remove("scale-95");
    },
  });
  observer.observe();

  // IP info
  initMyIP();

  // Fetch proxies lalu render
  try {
    await fetchProxyList();
    populateCountryDropdown();
    populateHostDropdown();
    applyFiltersAndRender(true);
  } catch (e) {
    console.error("Failed to init proxies:", e);
  }

  // Scroll pagination behavior
  window.onscroll = () => {
    const paginationContainer = $("container-pagination");
    if (!paginationContainer) return;
    if (window.innerHeight + Math.round(window.scrollY) >= document.body.offsetHeight) {
      paginationContainer.classList.remove("-translate-y-6");
    } else {
      paginationContainer.classList.add("-translate-y-6");
    }
  };
});
