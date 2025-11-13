// ==================== CONFIG ====================
const WORKER_BASE = "https://war.oranglemah.web.id"; // GANTI ke domain Worker kamu
const PRX_BANK_URL =
  "https://raw.githubusercontent.com/jaka2m/botak/refs/heads/main/cek/proxyList.txt";

const PORTS_DEFAULT = [443, 80];
const PROTOCOLS_DEFAULT = ["vless", "trojan", "ss"];
const PRX_PER_PAGE = 24;

// ==================== STATE ====================
let allProxies = []; // {prxIP, prxPort, country, org}
let filteredProxies = [];
let currentPage = 1;
let totalPages = 1;

let wildcardDomains = [];
let rawConfigBuffer = "";

// ==================== DOM ====================
const loadingScreen = document.getElementById("loading-screen");
const notification = document.getElementById("notification-badge");

const tbody = document.getElementById("proxy-tbody");
const totalProxyValue = document.getElementById("total-proxy-value");
const pageInfoValue = document.getElementById("page-info-value");
const paginationInfo = document.getElementById("pagination-info");
const pageButtons = document.getElementById("page-buttons");

const searchBar = document.getElementById("search-bar");
const btnSearch = document.getElementById("btn-search");

const selProtocol = document.getElementById("protocol-select");
const selCountry = document.getElementById("country-select");
const selHost = document.getElementById("host-select");
const selPort = document.getElementById("port-select");

const timeInfo = document.getElementById("time-info-value");
const infoIP = document.getElementById("info-ip").querySelector("span");
const infoCountry = document.getElementById("info-country").querySelector("span");
const infoISP = document.getElementById("info-isp").querySelector("span");

// FAB & windows
const fabMain = document.getElementById("fab-main");
const dropdownMenu = document.getElementById("dropdown-menu");

const wildcardsOverlay = document.getElementById("wildcards-overlay");
const btnWildcards = document.getElementById("btn-wildcards");
const btnCloseWildcards = document.getElementById("btn-close-wildcards");
const containerDomains = document.getElementById("container-domains");
const inputNewDomain = document.getElementById("new-domain-input");
const inputDeleteDomain = document.getElementById("delete-domain-input");
const btnRegisterDomain = document.getElementById("btn-register-domain");
const btnDeleteDomain = document.getElementById("btn-delete-domain");

// Donate / WA / TG
const btnDonateLink = document.getElementById("btn-donate");
const btnWhatsappLink = document.getElementById("btn-whatsapp");
const btnTelegramLink = document.getElementById("btn-telegram");

// Dark mode
const btnDarkmode = document.getElementById("btn-darkmode");

// ==================== HELPER UI ====================
function showLoading() {
  if (!loadingScreen) return;
  loadingScreen.style.opacity = "1";
  loadingScreen.style.display = "flex";
}
function hideLoading() {
  if (!loadingScreen) return;
  setTimeout(() => {
    loadingScreen.style.opacity = "0";
    setTimeout(() => (loadingScreen.style.display = "none"), 400);
  }, 700);
}

function showToast(msg = "Copied!") {
  if (!notification) return;
  notification.querySelector("p").textContent = msg;
  notification.classList.remove("opacity-0");
  setTimeout(() => notification.classList.add("opacity-0"), 2000);
}

function setRunningTitleAnimation() {
  const runningTitle = document.getElementById("runningTitle");
  if (!runningTitle) return;
  const container = runningTitle.parentElement;
  let position = -runningTitle.offsetWidth;
  const speed = 0.8;
  function animateTitle() {
    position += speed;
    if (position > container.offsetWidth) {
      position = -runningTitle.offsetWidth;
    }
    runningTitle.style.transform = "translateX(" + position + "px)";
    requestAnimationFrame(animateTitle);
  }
  animateTitle();
}

// ==================== DATA LOADERS ====================
async function fetchMyIP() {
  try {
    const res = await fetch(`${WORKER_BASE}/api/v1/myip`);
    if (!res.ok) return;
    const d = await res.json();
    infoIP.textContent = d.ip || "-";
    infoCountry.textContent = d.country || d.countryCode || "-";
    infoISP.textContent = d.asOrganization || d.asn || "-";
  } catch (_) {
    // ignore
  }
}

async function fetchProxyBank() {
  const res = await fetch(PRX_BANK_URL);
  if (!res.ok) throw new Error("Failed to fetch proxy bank");
  const text = await res.text();
  const lines = text.split("\n").filter(Boolean);

  allProxies = lines
    .map((line) => {
      const [ip, port, country, org] = line.split(",").map((x) => x.trim());
      if (!ip || !port) return null;
      return {
        prxIP: ip,
        prxPort: port,
        country: country || "UN",
        org: org || "Unknown",
      };
    })
    .filter(Boolean);

  filteredProxies = [...allProxies];
}

function applyFilter() {
  const search = (searchBar.value || "").trim().toLowerCase();
  const cc = selCountry.value || "all";

  filteredProxies = allProxies.filter((p) => {
    if (cc !== "all" && p.country !== cc) return false;
    if (!search) return true;
    const hit =
      p.prxIP.toLowerCase().includes(search) ||
      (p.prxPort || "").toLowerCase().includes(search) ||
      (p.country || "").toLowerCase().includes(search) ||
      (p.org || "").toLowerCase().includes(search);
    return hit;
  });

  currentPage = 1;
  renderTable();
}

// ==================== TABLE RENDER ====================
function renderCountryOptions() {
  const countries = new Set(allProxies.map((p) => p.country));
  const arr = Array.from(countries).sort();
  selCountry.innerHTML = `<option value="all">All Countries</option>`;
  arr.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    selCountry.appendChild(opt);
  });
}

function renderTable() {
  const total = filteredProxies.length;
  totalProxyValue.textContent = total.toString();

  totalPages = Math.max(1, Math.ceil(total / PRX_PER_PAGE));
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;

  const startIndex = (currentPage - 1) * PRX_PER_PAGE;
  const endIndex = Math.min(startIndex + PRX_PER_PAGE, total);
  const slice = filteredProxies.slice(startIndex, endIndex);

  pageInfoValue.textContent = `${currentPage}/${totalPages}`;
  paginationInfo.textContent = `Showing ${total ? startIndex + 1 : 0} to ${endIndex} of ${total} proxies`;

  // rows
  tbody.innerHTML = "";
  slice.forEach((prx, idx) => {
    const i = startIndex + idx;
    const tr = document.createElement("tr");
    tr.className =
      "hover:bg-slate-800/80 text-xs sm:text-sm text-slate-100 transition-colors";

    tr.innerHTML = `
      <td class="px-2 sm:px-3 py-3 text-center">${i + 1}</td>
      <td class="px-2 sm:px-3 py-3 font-mono text-center">${prx.prxIP}</td>
      <td class="px-2 sm:px-3 py-3 text-center">
        <div class="flex items-center justify-center gap-1">
          <img src="https://hatscripts.github.io/circle-flags/flags/${prx.country.toLowerCase()}.svg" width="18" height="18" class="rounded-full lozad scale-95" />
          <span>${prx.country}</span>
        </div>
      </td>
      <td class="px-2 sm:px-3 py-3 text-center">
        <div class="max-w-[130px] md:max-w-[200px] overflow-x-auto whitespace-nowrap">
          ${prx.org}
        </div>
      </td>
      <td id="ping-${i}" class="px-2 sm:px-3 py-3 text-center text-xs text-slate-200">
        ${prx.prxIP}:${prx.prxPort}
      </td>
      <td class="px-2 sm:px-3 py-3 text-center">
        <button
          class="px-3 py-1 text-xs sm:text-sm text-white rounded-md bg-slate-800 hover:bg-slate-700 border border-slate-600 shadow-sm"
          data-index="${i}"
        >
          Config
        </button>
      </td>
    `;

    const btn = tr.querySelector("button");
    btn.addEventListener("click", () => handleCopyConfig(i));

    tbody.appendChild(tr);
  });

  renderPaginationButtons();

  // observe flags animation
  if (window.lozad) {
    const observer = lozad(".lozad", {
      load: function (el) {
        el.classList.remove("scale-95");
      },
    });
    observer.observe();
  }

  // run ping check for visible list
  checkProxyForSlice(startIndex, endIndex);
}

function renderPaginationButtons() {
  pageButtons.innerHTML = "";

  function addBtn(label, page, disabled = false) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.className =
      "px-3 py-1 sm:px-4 sm:py-2 rounded-lg text-xs sm:text-sm font-semibold btn-gradient disabled:opacity-40";
    btn.disabled = disabled;
    btn.addEventListener("click", () => {
      currentPage = page;
      renderTable();
    });
    li.appendChild(btn);
    pageButtons.appendChild(li);
  }

  addBtn("Prev", currentPage - 1, currentPage <= 1);
  addBtn("Next", currentPage + 1, currentPage >= totalPages);
}

// ==================== PING CHECK ====================
function checkProxyForSlice(startIndex, endIndex) {
  for (let i = startIndex; i < endIndex; i++) {
    const prx = filteredProxies[i];
    if (!prx) continue;
    const pingElement = document.getElementById(`ping-${i}`);
    if (!pingElement) continue;

    const target = `${prx.prxIP}:${prx.prxPort}`;
    pingElement.textContent = "Checking...";
    pingElement.classList.remove("text-green-400", "text-red-400");

    fetch(`${WORKER_BASE}/check?target=${encodeURIComponent(target)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then((json) => {
        if (json.status === "ACTIVE") {
          const delay =
            typeof json.rtt_ms === "number" ? json.rtt_ms + "ms" : "N/A";
          const colo = json.colo || "N/A";
          pingElement.innerHTML = `<span class="blink-text text-green-400">Active</span><br><span class="text-[10px] font-normal text-amber-300">${delay} (${colo})</span>`;
        } else {
          const err = json.error ? " – " + json.error : "";
          pingElement.textContent = "Inactive" + err;
          pingElement.classList.add("text-red-400");
        }
      })
      .catch(() => {
        pingElement.textContent = "Fetch Error!";
        pingElement.classList.add("text-red-400");
      });
  }
}

// ==================== CONFIG GENERATOR (CALL WORKER) ====================
async function handleCopyConfig(globalIndex) {
  const prx = filteredProxies[globalIndex];
  if (!prx) return;

  const protocolVal = selProtocol.value || "all";
  const portVal = selPort.value || "all";
  const hostVal = selHost.value || "default";

  const vpnParam =
    protocolVal === "all"
      ? PROTOCOLS_DEFAULT.join(",")
      : protocolVal;

  const portParam =
    portVal === "all"
      ? PORTS_DEFAULT.join(",")
      : portVal;

  let domainParam = "";
  if (hostVal === "default") {
    // biarkan kosong -> APP_DOMAIN di Worker
    domainParam = "";
  } else {
    domainParam = hostVal;
  }

  const params = new URLSearchParams();
  params.set("format", "raw");
  params.set("limit", "10");
  if (vpnParam) params.set("vpn", vpnParam);
  if (portParam) params.set("port", portParam);
  if (domainParam) params.set("domain", domainParam);

  const targetStr = `${prx.prxIP}-${prx.prxPort}`;
  params.set("target", targetStr);

  try {
    const res = await fetch(`${WORKER_BASE}/api/v1/sub?` + params.toString());
    if (!res.ok) throw new Error("HTTP " + res.status);
    const text = await res.text();
    rawConfigBuffer = text.trim();
    await navigator.clipboard.writeText(rawConfigBuffer);
    showToast("Config berhasil disalin");
  } catch (e) {
    console.error(e);
    showToast("Gagal generate config");
  }
}

// ==================== WILDCARD DOMAIN MANAGEMENT ====================
async function fetchDomainList() {
  try {
    const res = await fetch(`${WORKER_BASE}/api/v1/domains/get`);
    if (!res.ok) return;
    wildcardDomains = await res.json();
    renderDomainList();
  } catch (_) {
    // ignore
  }
}

function renderDomainList() {
  containerDomains.innerHTML = "";
  wildcardDomains.forEach((d, idx) => {
    const row = document.createElement("div");
    row.className =
      "flex items-center justify-between w-full rounded-md px-2 py-1 bg-slate-900/80 text-[11px]";
    row.innerHTML = `<span>${idx + 1}. ${d.hostname}</span>`;
    containerDomains.appendChild(row);
  });
}

async function registerDomain() {
  const raw = (inputNewDomain.value || "").trim().toLowerCase();
  if (!raw || !/\w+\.\w+/.test(raw)) {
    Swal.fire({
      title: "Error",
      text: "Format wildcard tidak valid (ex: sub.domain)",
      icon: "error",
      timer: 1500,
      showConfirmButton: false,
      width: "300px",
    });
    return;
  }
  const domain = raw.endsWith(rootDomain()) ? raw : `${raw}.${rootDomain()}`;

  try {
    const res = await fetch(
      `${WORKER_BASE}/api/v1/domains/put?domain=${encodeURIComponent(domain)}`
    );
    if (res.status === 200) {
      inputNewDomain.value = "";
      await fetchDomainList();
      Swal.fire({
        title: "Berhasil",
        text: "Domain ditambahkan",
        icon: "success",
        timer: 1500,
        showConfirmButton: false,
        width: "300px",
      });
    } else if (res.status === 409) {
      Swal.fire({
        title: "Info",
        text: "Domain sudah terdaftar",
        icon: "info",
        timer: 1800,
        showConfirmButton: false,
        width: "300px",
      });
    } else {
      Swal.fire({
        title: "Gagal",
        text: "Status: " + res.status,
        icon: "error",
        timer: 1500,
        showConfirmButton: false,
        width: "300px",
      });
    }
  } catch (e) {
    Swal.fire({
      title: "Error",
      text: e.message || "Unknown error",
      icon: "error",
      timer: 1500,
      showConfirmButton: false,
      width: "300px",
    });
  }
}

function rootDomain() {
  // dari WORKER_BASE: https://sambat.nailamazy.biz.id -> nailamazy.biz.id
  try {
    const u = new URL(WORKER_BASE);
    const host = u.hostname; // sambat.nailamazy.biz.id
    const parts = host.split(".");
    if (parts.length >= 3) {
      return parts.slice(1).join(".");
    }
    return host;
  } catch (_) {
    return "nailamazy.biz.id";
  }
}

function deleteDomainByNumber() {
  const num = parseInt(inputDeleteDomain.value, 10);
  if (isNaN(num) || num < 1 || num > wildcardDomains.length) {
    Swal.fire({
      title: "Error",
      text: "Nomor urut tidak valid",
      icon: "error",
      timer: 1500,
      showConfirmButton: false,
      width: "300px",
    });
    return;
  }
  const domain = wildcardDomains[num - 1];
  Swal.fire({
    title: "Masukkan Password",
    text: "Untuk menghapus domain: " + domain.hostname,
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
      const url = `${WORKER_BASE}/api/v1/domains/delete?id=${domain.id}&password=${encodeURIComponent(
        password
      )}`;
      return fetch(url, { method: "DELETE" })
        .then((res) => {
          if (!res.ok) {
            if (res.status === 401) throw new Error("Password salah!");
            throw new Error("Gagal! Status: " + res.status);
          }
          return {};
        })
        .catch((err) => {
          Swal.showValidationMessage(err.message);
          return false;
        });
    },
    allowOutsideClick: () => !Swal.isLoading(),
  }).then((result) => {
    if (result.isConfirmed) {
      Swal.fire({
        title: "Berhasil",
        text: "Domain dihapus",
        icon: "success",
        timer: 1500,
        showConfirmButton: false,
        width: "300px",
      });
      inputDeleteDomain.value = "";
      fetchDomainList();
    }
  });
}

// ==================== THEME & MISC ====================
function initDarkMode() {
  const root = document.getElementById("html");
  const stored = localStorage.getItem("theme");
  if (stored === "light") {
    root.classList.remove("dark");
  } else {
    root.classList.add("dark");
  }
}

function toggleDarkMode() {
  const root = document.getElementById("html");
  if (root.classList.contains("dark")) {
    root.classList.remove("dark");
    localStorage.setItem("theme", "light");
  } else {
    root.classList.add("dark");
    localStorage.setItem("theme", "dark");
  }
}

function updateTime() {
  if (!timeInfo) return;
  const now = new Date();
  timeInfo.textContent = now.toLocaleTimeString("en-GB");
}

// ==================== FAB ====================
function toggleFabMenu() {
  dropdownMenu.classList.toggle("hidden");
}

function showWildcardsWindow() {
  wildcardsOverlay.classList.remove("hidden");
  fetchDomainList();
}

function hideWildcardsWindow() {
  wildcardsOverlay.classList.add("hidden");
}

// ==================== INIT ====================
document.addEventListener("DOMContentLoaded", async () => {
  initDarkMode();
  setRunningTitleAnimation();
  showLoading();

  // Set static buttons
  btnDonateLink.href = "https://github.com/oranglemah/khusus/raw/main/qris.jpg";
  btnWhatsappLink.href = "https://wa.me/0895325108287";
  const tgUser = "@Oranglemah97".replace(/^@/, "");
  btnTelegramLink.href = `https://t.me/${tgUser}`;

  fabMain.addEventListener("click", toggleFabMenu);
  btnDarkmode.addEventListener("click", toggleDarkMode);

  btnWildcards.addEventListener("click", showWildcardsWindow);
  btnCloseWildcards.addEventListener("click", hideWildcardsWindow);
  btnRegisterDomain.addEventListener("click", registerDomain);
  btnDeleteDomain.addEventListener("click", deleteDomainByNumber);

  btnSearch.addEventListener("click", applyFilter);
  searchBar.addEventListener("keydown", (e) => {
    if (e.key === "Enter") applyFilter();
  });

  selCountry.addEventListener("change", applyFilter);

  // Clock
  updateTime();
  setInterval(updateTime, 1000);

  try {
    await Promise.all([fetchMyIP(), fetchProxyBank()]);
    renderCountryOptions();
    renderTable();
  } catch (e) {
    console.error(e);
  } finally {
    hideLoading();
  }
});
