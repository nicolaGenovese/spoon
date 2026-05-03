"use strict";

// Endpoint pubblico WordPress REST di Wetherspoon usato come sorgente live.
const PUBS_API_URL = "https://www.jdwetherspoon.com/wp-json/wp/v2/pubs";
const PUBS_API_FIELDS = "id,slug,link,title,acf";
const PUBS_API_PAGE_SIZE = 100;
const CLOUD_CONFIG = window.SPOON_CLOUD_CONFIG || {};
const CLOUD_TABLE = CLOUD_CONFIG.table || "pub_claims";
const CLOUD_VOTES_TABLE = CLOUD_CONFIG.votesTable || "pub_claim_votes";

// Chiavi localStorage: lo stato del gioco resta salvato solo in questo browser.
const CLAIMS_STORAGE_KEY = "wetherspoonPubRace.claims.api.v1";
const CLAIM_VOTES_STORAGE_KEY = "wetherspoonPubRace.claimVotes.api.v1";
const ACTIVE_PLAYER_STORAGE_KEY = "wetherspoonPubRace.activePlayer.v1";

const PLAYERS = [
  { id: "daniel", name: "Daniel", color: "#991b1b", dark: "#7f1d1d" },
  { id: "stefano", name: "Stefano", color: "#2563eb", dark: "#1d4ed8" },
  { id: "nicola", name: "Nicola", color: "#15803d", dark: "#166534" }
];
const PLAYER_BY_ID = new Map(PLAYERS.map(player => [player.id, player]));

const mapElement = document.getElementById("map");
const map = L.map(mapElement, {
  scrollWheelZoom: true,
  updateWhenIdle: true
}).setView([54.5, -3.2], 6);

// Le tile OpenStreetMap sono separate dai dati pub caricati dall'API Wetherspoon.
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  keepBuffer: 5,
  updateWhenIdle: true,
  updateWhenZooming: false,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

const markersLayer = L.layerGroup().addTo(map);
const freeMarkerStyle = {
  radius: 6.5,
  color: "#ffffff",
  weight: 2.5,
  opacity: 1,
  fillColor: "#334155",
  fillOpacity: 0.95,
  className: "pub-marker pub-marker-free"
};

// Stato mutabile dell'app: pub caricati, ricerca, spunte e giocatore attivo.
let pubs = [];
let filteredPubs = [];
let claims = loadClaims();
let claimVotes = loadClaimVotes();
let activePlayerId = loadActivePlayerId();
let cloudClient = null;
const markerById = new Map();

const els = {
  searchInput: document.getElementById("searchInput"),
  results: document.getElementById("results"),
  totalCount: document.getElementById("totalCount"),
  visibleCount: document.getElementById("visibleCount"),
  claimedCount: document.getElementById("claimedCount"),
  pendingCount: document.getElementById("pendingCount"),
  unclaimedCount: document.getElementById("unclaimedCount"),
  playerPicker: document.getElementById("playerPicker"),
  scoreboard: document.getElementById("scoreboard"),
  fitBtn: document.getElementById("fitBtn"),
  clearBtn: document.getElementById("clearBtn"),
  statusDot: document.getElementById("statusDot"),
  statusText: document.getElementById("statusText")
};

function refreshMapSize() {
  map.invalidateSize({ animate: false, pan: false });
}

function scheduleMapRefresh() {
  requestAnimationFrame(() => {
    refreshMapSize();
    window.setTimeout(refreshMapSize, 150);
  });
}

scheduleMapRefresh();
window.addEventListener("load", scheduleMapRefresh);
window.addEventListener("resize", scheduleMapRefresh);

if ("ResizeObserver" in window) {
  const resizeObserver = new ResizeObserver(scheduleMapRefresh);
  resizeObserver.observe(mapElement);
}

function setStatus(message, type = "") {
  els.statusText.textContent = message;
  els.statusDot.className = ["dot", type].filter(Boolean).join(" ");
}

function getCloudClient() {
  if (!CLOUD_CONFIG.enabled || CLOUD_CONFIG.provider !== "supabase") return null;
  if (!CLOUD_CONFIG.supabaseUrl || !CLOUD_CONFIG.supabaseAnonKey || !window.supabase) return null;

  if (!cloudClient) {
    cloudClient = window.supabase.createClient(CLOUD_CONFIG.supabaseUrl, CLOUD_CONFIG.supabaseAnonKey);
  }

  return cloudClient;
}

function isCloudConfigured() {
  return Boolean(getCloudClient());
}

function loadClaims() {
  try {
    const stored = JSON.parse(localStorage.getItem(CLAIMS_STORAGE_KEY) || "{}");
    return stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  } catch (error) {
    console.warn("Spunte non caricate", error);
    return {};
  }
}

function saveClaims() {
  localStorage.setItem(CLAIMS_STORAGE_KEY, JSON.stringify(claims));
}

function loadClaimVotes() {
  try {
    const stored = JSON.parse(localStorage.getItem(CLAIM_VOTES_STORAGE_KEY) || "{}");
    return stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  } catch (error) {
    console.warn("Validazioni non caricate", error);
    return {};
  }
}

function saveClaimVotes() {
  localStorage.setItem(CLAIM_VOTES_STORAGE_KEY, JSON.stringify(claimVotes));
}

function rowsToClaims(rows) {
  return Object.fromEntries(
    rows
      .filter(row => row.pub_id && PLAYER_BY_ID.has(row.player_id))
      .map(row => [String(row.pub_id), row.player_id])
  );
}

function rowsToClaimVotes(rows) {
  return (rows || []).reduce((votesByPub, row) => {
    if (!row.pub_id || !PLAYER_BY_ID.has(row.voter_id) || !["approve", "reject"].includes(row.vote)) {
      return votesByPub;
    }

    const pubId = String(row.pub_id);
    votesByPub[pubId] = votesByPub[pubId] || {};
    votesByPub[pubId][row.voter_id] = row.vote;
    return votesByPub;
  }, {});
}

async function loadCloudClaims() {
  const client = getCloudClient();
  if (!client) return false;

  const [claimsResult, votesResult] = await Promise.all([
    client.from(CLOUD_TABLE).select("pub_id,player_id"),
    client.from(CLOUD_VOTES_TABLE).select("pub_id,voter_id,vote")
  ]);

  if (claimsResult.error || votesResult.error) {
    console.warn("Spunte cloud non caricate", claimsResult.error || votesResult.error);
    return false;
  }

  claims = rowsToClaims(claimsResult.data || []);
  claimVotes = rowsToClaimVotes(votesResult.data || []);
  saveClaims();
  saveClaimVotes();
  return true;
}

async function insertCloudClaim(pubId, playerId) {
  const client = getCloudClient();
  if (!client) return true;

  const { error } = await client
    .from(CLOUD_TABLE)
    .insert({ pub_id: String(pubId), player_id: playerId });

  if (error) {
    console.warn("Spunta cloud non salvata", error);
    return false;
  }

  return true;
}

async function deleteCloudClaim(pubId, playerId) {
  const client = getCloudClient();
  if (!client) return true;

  const { error } = await client
    .from(CLOUD_TABLE)
    .delete()
    .eq("pub_id", String(pubId))
    .eq("player_id", playerId);

  if (error) {
    console.warn("Spunta cloud non rimossa", error);
    return false;
  }

  return true;
}

async function upsertCloudVote(pubId, voterId, vote) {
  const client = getCloudClient();
  if (!client) return true;

  const { error } = await client
    .from(CLOUD_VOTES_TABLE)
    .upsert(
      { pub_id: String(pubId), voter_id: voterId, vote },
      { onConflict: "pub_id,voter_id" }
    );

  if (error) {
    console.warn("Validazione cloud non salvata", error);
    return false;
  }

  return true;
}

function loadActivePlayerId() {
  const stored = localStorage.getItem(ACTIVE_PLAYER_STORAGE_KEY);
  return PLAYER_BY_ID.has(stored) ? stored : PLAYERS[0].id;
}

function saveActivePlayerId() {
  localStorage.setItem(ACTIVE_PLAYER_STORAGE_KEY, activePlayerId);
}

function getPlayer(playerId) {
  return PLAYER_BY_ID.get(playerId) || null;
}

function getActivePlayer() {
  return getPlayer(activePlayerId) || PLAYERS[0];
}

function getClaim(pubId) {
  return claims[String(pubId)] || "";
}

function getClaimPlayer(pubId) {
  return getPlayer(getClaim(pubId));
}

function getClaimVotes(pubId) {
  return claimVotes[String(pubId)] || {};
}

function getVoteSummary(pubId) {
  const claimedBy = getClaimPlayer(pubId);
  const votes = getClaimVotes(pubId);
  const eligibleVoters = PLAYERS.filter(player => !claimedBy || player.id !== claimedBy.id);
  const approvals = eligibleVoters.filter(player => votes[player.id] === "approve");
  const rejections = eligibleVoters.filter(player => votes[player.id] === "reject");

  return {
    approvals,
    rejections,
    requiredRejections: eligibleVoters.length
  };
}

function isClaimValidated(pubId) {
  return getVoteSummary(pubId).approvals.length > 0;
}

function shouldCancelClaim(pubId) {
  const summary = getVoteSummary(pubId);
  return summary.requiredRejections > 0 && summary.rejections.length >= summary.requiredRejections;
}

function getValidatedClaimedCount() {
  return Object.keys(claims).filter(isClaimValidated).length;
}

function getPendingClaimedCount() {
  return Object.keys(claims).filter(pubId => !isClaimValidated(pubId)).length;
}

// Elimina spunte e voti salvati se l'API non restituisce più quel pub o giocatore.
function cleanClaims() {
  const validPubIds = new Set(pubs.map(pub => String(pub.id)));
  claims = Object.fromEntries(
    Object.entries(claims).filter(([pubId, playerId]) => validPubIds.has(pubId) && PLAYER_BY_ID.has(playerId))
  );
  claimVotes = Object.fromEntries(
    Object.entries(claimVotes)
      .filter(([pubId]) => validPubIds.has(pubId) && claims[pubId])
      .map(([pubId, votes]) => [
        pubId,
        Object.fromEntries(
          Object.entries(votes).filter(([playerId, vote]) => PLAYER_BY_ID.has(playerId) && ["approve", "reject"].includes(vote))
        )
      ])
  );
  saveClaims();
  saveClaimVotes();
}

function playerStyleVars(player) {
  return "--player-color: " + escapeAttr(player.color) + "; --player-dark: " + escapeAttr(player.dark) + ";";
}

function claimStyleVars(player) {
  return "--claim-color: " + escapeAttr(player.color) + ";";
}

function getScore(playerId) {
  return Object.entries(claims)
    .filter(([pubId, claimedBy]) => claimedBy === playerId && isClaimValidated(pubId))
    .length;
}

function renderPlayerPicker() {
  els.playerPicker.innerHTML = PLAYERS
    .map(player => {
      const isActive = player.id === activePlayerId;
      return [
        '<button class="player-tab' + (isActive ? " is-active" : "") + '"',
        ' type="button"',
        ' data-player-id="' + escapeAttr(player.id) + '"',
        ' style="' + playerStyleVars(player) + '">',
        escapeHTML(player.name),
        '</button>'
      ].join("");
    })
    .join("");
}

function renderScoreboard() {
  els.scoreboard.innerHTML = PLAYERS
    .map(player => [
      '<div class="score" style="' + playerStyleVars(player) + '">',
      '<strong>' + getScore(player.id) + '</strong>',
      '<span>' + escapeHTML(player.name) + '</span>',
      '</div>'
    ].join(""))
    .join("");
}

function updateCounters() {
  const occupiedCount = Object.keys(claims).length;
  els.claimedCount.textContent = String(getValidatedClaimedCount());
  els.pendingCount.textContent = String(getPendingClaimedCount());
  els.unclaimedCount.textContent = String(Math.max(pubs.length - occupiedCount, 0));
  renderScoreboard();
}

function setActivePlayer(playerId) {
  if (!PLAYER_BY_ID.has(playerId)) return;
  activePlayerId = playerId;
  saveActivePlayerId();
  renderPlayerPicker();
  map.closePopup();
  setStatus("Giocatore attivo: " + getActivePlayer().name + ".", "good");
}

function markerStyleFor(pub) {
  const player = getClaimPlayer(pub.id);
  if (!player) return freeMarkerStyle;
  return {
    radius: 8,
    color: "#ffffff",
    weight: 3,
    opacity: 1,
    fillColor: player.color,
    fillOpacity: 1,
    className: "pub-marker pub-marker-claimed"
  };
}

// Ogni pub può essere segnato da un solo giocatore; gli altri restano bloccati.
async function claimPub(pubId, playerId) {
  const key = String(pubId);
  const pub = pubs.find(item => item.id === key);
  const player = getPlayer(playerId);
  if (!pub || !player) return;

  const existingPlayer = getClaimPlayer(key);
  if (existingPlayer && existingPlayer.id !== player.id) {
    setStatus(pub.name + " è già stato visitato da " + existingPlayer.name + ".", "bad");
    focusPub(key);
    return;
  }

  if (!(await insertCloudClaim(key, player.id))) {
    await loadCloudClaims();
    render();
    const remotePlayer = getClaimPlayer(key);
    const message = remotePlayer
      ? pub.name + " è già stato visitato da " + remotePlayer.name + "."
      : "Non riesco a salvare la spunta nel database condiviso.";
    setStatus(message, "bad");
    focusPub(key);
    return;
  }

  claims[key] = player.id;
  delete claimVotes[key];
  saveClaims();
  saveClaimVotes();
  render();
  setStatus(pub.name + " segnato per " + player.name + ". In attesa di validazione.", "good");
  focusPub(key);
}

async function unclaimPub(pubId) {
  const key = String(pubId);
  const pub = pubs.find(item => item.id === key);
  const existingPlayer = getClaimPlayer(key);
  if (!pub || !existingPlayer) return;

  if (existingPlayer.id !== activePlayerId) {
    setStatus("Spunta bloccata: " + pub.name + " è di " + existingPlayer.name + ".", "bad");
    focusPub(key);
    return;
  }

  if (!(await deleteCloudClaim(key, existingPlayer.id))) {
    await loadCloudClaims();
    render();
    setStatus("Non riesco a rimuovere la spunta dal database condiviso.", "bad");
    focusPub(key);
    return;
  }

  delete claims[key];
  delete claimVotes[key];
  saveClaims();
  saveClaimVotes();
  render();
  setStatus("Spunta rimossa da " + pub.name + ".", "good");
  focusPub(key);
}

async function voteOnClaim(pubId, voterId, vote) {
  const key = String(pubId);
  const pub = pubs.find(item => item.id === key);
  const claimedBy = getClaimPlayer(key);
  const voter = getPlayer(voterId);
  if (!pub || !claimedBy || !voter || !["approve", "reject"].includes(vote)) return;

  if (claimedBy.id === voter.id) {
    setStatus("Non puoi validare una visita segnata da te.", "bad");
    focusPub(key);
    return;
  }

  if (!(await upsertCloudVote(key, voter.id, vote))) {
    await loadCloudClaims();
    cleanClaims();
    render();
    setStatus("Non riesco a salvare la validazione nel database condiviso.", "bad");
    focusPub(key);
    return;
  }

  claimVotes[key] = claimVotes[key] || {};
  claimVotes[key][voter.id] = vote;
  saveClaimVotes();

  if (shouldCancelClaim(key)) {
    if (!(await deleteCloudClaim(key, claimedBy.id))) {
      await loadCloudClaims();
      cleanClaims();
      render();
      setStatus("Visita rifiutata, ma non riesco ad annullarla nel database condiviso.", "bad");
      focusPub(key);
      return;
    }

    delete claims[key];
    delete claimVotes[key];
    saveClaims();
    saveClaimVotes();
    render();
    setStatus("Visita annullata: " + pub.name + " è stata rifiutata dagli altri giocatori.", "bad");
    focusPub(key);
    return;
  }

  render();
  setStatus(
    vote === "approve"
      ? "Visita validata da " + voter.name + "."
      : "Visita rifiutata da " + voter.name + ".",
    vote === "approve" ? "good" : "bad"
  );
  focusPub(key);
}

function validationStateHTML(pub) {
  const summary = getVoteSummary(pub.id);
  const approvals = summary.approvals.map(player => player.name).join(", ");
  const rejections = summary.rejections.map(player => player.name).join(", ");

  if (summary.approvals.length) {
    return '<div class="popup-state claimed" style="' + claimStyleVars(summary.approvals[0]) + '">Validato da ' + escapeHTML(approvals) + '</div>';
  }

  if (summary.rejections.length) {
    return '<div class="popup-state rejected">Rifiutato da ' + escapeHTML(rejections) + '</div>';
  }

  return '<div class="popup-state pending">In attesa di validazione</div>';
}

function voteControlsHTML(pub, activePlayer, claimedBy) {
  if (activePlayer.id === claimedBy.id) {
    return [
      '<button class="popup-action secondary" type="button" data-game-action="unclaim"',
      ' data-pub-id="' + escapeAttr(pub.id) + '">Togli spunta</button>'
    ].join("");
  }

  const currentVote = getClaimVotes(pub.id)[activePlayer.id] || "";
  return [
    '<div class="popup-vote-actions">',
    '<button class="popup-action" type="button" data-game-action="approve"',
    ' data-pub-id="' + escapeAttr(pub.id) + '"',
    ' data-player-id="' + escapeAttr(activePlayer.id) + '"',
    ' style="' + playerStyleVars(activePlayer) + '">',
    currentVote === "approve" ? "Validato da te" : "Valida visita",
    '</button>',
    '<button class="popup-action secondary" type="button" data-game-action="reject"',
    ' data-pub-id="' + escapeAttr(pub.id) + '"',
    ' data-player-id="' + escapeAttr(activePlayer.id) + '">',
    currentVote === "reject" ? "Rifiutato da te" : "Rifiuta",
    '</button>',
    '</div>'
  ].join("");
}

function claimControlsHTML(pub) {
  const activePlayer = getActivePlayer();
  const claimedBy = getClaimPlayer(pub.id);

  if (!claimedBy) {
    return [
      '<div class="popup-game">',
      '<div class="popup-state">Pub libero</div>',
      '<button class="popup-action" type="button" data-game-action="claim"',
      ' data-pub-id="' + escapeAttr(pub.id) + '"',
      ' data-player-id="' + escapeAttr(activePlayer.id) + '"',
      ' style="' + playerStyleVars(activePlayer) + '">',
      'Metti spunta per ' + escapeHTML(activePlayer.name),
      '</button>',
      '</div>'
    ].join("");
  }

  return [
    '<div class="popup-game">',
    '<div class="popup-state claimed" style="' + claimStyleVars(claimedBy) + '">',
    'Visitato da ' + escapeHTML(claimedBy.name),
    '</div>',
    validationStateHTML(pub),
    voteControlsHTML(pub, activePlayer, claimedBy),
    '</div>'
  ].join("");
}

function apiURL(page) {
  const url = new URL(PUBS_API_URL);
  url.searchParams.set("per_page", String(PUBS_API_PAGE_SIZE));
  url.searchParams.set("page", String(page));
  url.searchParams.set("_fields", PUBS_API_FIELDS);
  url.searchParams.set("orderby", "id");
  url.searchParams.set("order", "asc");
  return url.toString();
}

async function fetchAPIPubsPage(page) {
  const response = await fetch(apiURL(page), { cache: "no-store" });
  if (!response.ok) throw new Error("HTTP " + response.status);

  const data = await response.json();
  if (!Array.isArray(data)) throw new Error("Risposta API non valida");

  return {
    data,
    totalPages: Number(response.headers.get("X-WP-TotalPages") || "1")
  };
}

// Converte la risposta Wetherspoon nel formato più piccolo usato dal gioco.
function normalizeAPIPub(apiPub) {
  const acf = apiPub.acf || {};
  const stableId = acf.jdw_pub_id ? "jdw-" + acf.jdw_pub_id : "wp-" + apiPub.id;
  const name = apiPub.title && apiPub.title.rendered ? htmlToText(apiPub.title.rendered) : "Pub senza nome";
  const street = acf.address_line_1 || acf.full_address || "";
  const locality = acf.towncity || "";
  const region = acf.county || acf.country || "";

  return {
    id: stableId,
    wpId: apiPub.id,
    slug: apiPub.slug || "",
    name,
    lat: Number(acf.latitude),
    lng: Number(acf.longitude),
    street,
    locality,
    region,
    postcode: acf.postcode || "",
    telephone: acf.phone_number || "",
    url: apiPub.link || "",
    fullAddress: acf.full_address || [street, locality, region, acf.postcode].filter(Boolean).join(", ")
  };
}

function isCopySlug(pub) {
  return /-\d+$/.test(pub.slug || "");
}

function preferPub(existingPub, candidatePub) {
  if (isCopySlug(existingPub) && !isCopySlug(candidatePub)) return candidatePub;
  return existingPub;
}

// L'API può esporre duplicati con lo stesso jdw_pub_id: ne teniamo uno solo.
function dedupePubs(pubsToDedupe) {
  const byId = new Map();
  pubsToDedupe.forEach(pub => {
    const existingPub = byId.get(pub.id);
    byId.set(pub.id, existingPub ? preferPub(existingPub, pub) : pub);
  });
  return Array.from(byId.values());
}

async function loadPubsFromAPI() {
  try {
    setStatus("Caricamento dati pub dall'API Wetherspoon...", "");
    const firstPage = await fetchAPIPubsPage(1);
    const totalPages = Math.max(firstPage.totalPages, 1);
    const remainingPages = [];

    for (let page = 2; page <= totalPages; page += 1) {
      remainingPages.push(fetchAPIPubsPage(page));
    }

    const remainingResults = await Promise.all(remainingPages);
    const data = [firstPage, ...remainingResults].flatMap(result => result.data);

    if (!data.length) throw new Error("API senza pub");

    const normalizedPubs = data
      .map(normalizeAPIPub)
      .filter(pub => Number.isFinite(pub.lat) && Number.isFinite(pub.lng));

    pubs = dedupePubs(normalizedPubs);
    const cloudLoaded = await loadCloudClaims();
    cleanClaims();
    filteredPubs = pubs.slice();
    els.totalCount.textContent = String(pubs.length);

    const duplicateCount = normalizedPubs.length - pubs.length;
    const details = [];
    if (duplicateCount) details.push(duplicateCount + " duplicati esclusi");
    if (cloudLoaded) details.push("database condiviso attivo");
    if (isCloudConfigured() && !cloudLoaded) details.push("database condiviso non raggiungibile");
    const detailText = details.length ? " (" + details.join(", ") + ")." : ".";
    setStatus(
      "Dati aggiornati dall'API. " + pubs.length + " pub in gioco" + detailText,
      cloudLoaded || !isCloudConfigured() ? "good" : "bad"
    );
    render();
    scheduleMapRefresh();
    fitToVisible(false);
  } catch (error) {
    console.error(error);
    setStatus("Non riesco a caricare i pub dall'API Wetherspoon.", "bad");
    els.results.innerHTML = '<div class="empty">Dati non caricati. Controlla la connessione e riprova.</div>';
  }
}

function popupHTML(pub) {
  const address = pub.fullAddress || [pub.street, pub.locality, pub.region, pub.postcode].filter(Boolean).join(", ");
  const phone = pub.telephone ? "<div>" + escapeHTML(pub.telephone) + "</div>" : "";
  const link = pub.url
    ? '<a class="popup-link" href="' + escapeAttr(pub.url) + '" target="_blank" rel="noopener">Apri pagina pub</a>'
    : "";

  return [
    '<div class="popup-title">' + escapeHTML(pub.name) + '</div>',
    '<div>' + escapeHTML(address) + '</div>',
    phone,
    link,
    claimControlsHTML(pub)
  ].join("");
}

function renderMarkers() {
  markersLayer.clearLayers();
  markerById.clear();

  filteredPubs.forEach(pub => {
    const marker = L.circleMarker([pub.lat, pub.lng], markerStyleFor(pub)).bindPopup(() => popupHTML(pub));
    marker.addTo(markersLayer);
    markerById.set(pub.id, marker);
  });
}

function renderResults() {
  els.visibleCount.textContent = String(filteredPubs.length);

  if (!pubs.length) {
    els.results.innerHTML = '<div class="empty">Nessun pub caricato.</div>';
    return;
  }

  if (!filteredPubs.length) {
    els.results.innerHTML = '<div class="empty">Nessun pub trovato.</div>';
    return;
  }

  els.results.innerHTML = filteredPubs
    .slice(0, 500)
    .map(pub => {
      const address = pub.fullAddress || [pub.street, pub.locality, pub.region, pub.postcode].filter(Boolean).join(", ");
      const claimedBy = getClaimPlayer(pub.id);
      const articleClass = "card" + (claimedBy ? " claimed" : "");
      const articleStyle = claimedBy ? ' style="' + claimStyleVars(claimedBy) + '"' : "";
      const state = resultStateHTML(pub, claimedBy);
      return [
        '<article class="' + articleClass + '" data-id="' + escapeAttr(pub.id) + '"' + articleStyle + '>',
        '<div class="card-title">' + escapeHTML(pub.name) + '</div>',
        '<div class="card-meta">' + escapeHTML(address) + '</div>',
        state,
        '</article>'
      ].join("");
    })
    .join("");

  if (filteredPubs.length > 500) {
    els.results.insertAdjacentHTML("beforeend", '<div class="empty">Mostrati i primi 500 risultati. Usa la ricerca per restringere.</div>');
  }
}

function resultStateHTML(pub, claimedBy) {
  if (!claimedBy) return '<div class="card-state">Pub libero</div>';

  const summary = getVoteSummary(pub.id);
  if (summary.approvals.length) {
    return '<div class="card-state claimed" style="' + claimStyleVars(claimedBy) + '">Validato per ' + escapeHTML(claimedBy.name) + '</div>';
  }

  if (summary.rejections.length) {
    return '<div class="card-state rejected">Contestato: ' + summary.rejections.length + '/' + summary.requiredRejections + '</div>';
  }

  return '<div class="card-state pending">In attesa: ' + escapeHTML(claimedBy.name) + '</div>';
}

function render() {
  renderMarkers();
  renderResults();
  updateCounters();
}

function filterPubs() {
  const query = els.searchInput.value.trim().toLowerCase();

  if (!query) {
    filteredPubs = pubs.slice();
  } else {
    filteredPubs = pubs.filter(pub => {
      const haystack = [
        pub.name,
        pub.slug,
        pub.street,
        pub.locality,
        pub.region,
        pub.postcode,
        pub.telephone,
        pub.fullAddress
      ].join(" ").toLowerCase();

      return haystack.includes(query);
    });
  }

  render();
  fitToVisible(false);
}

function fitToVisible(animate = true) {
  if (!filteredPubs.length) return;
  const bounds = L.latLngBounds(filteredPubs.map(pub => [pub.lat, pub.lng]));
  map.fitBounds(bounds, { padding: [40, 40], animate, maxZoom: 14 });
}

function focusPub(id) {
  const key = String(id);
  const pub = pubs.find(item => item.id === key);
  const marker = markerById.get(key);
  if (!pub || !marker) return;
  map.setView([pub.lat, pub.lng], 15, { animate: true });
  marker.openPopup();
}

function htmlToText(value) {
  const doc = new DOMParser().parseFromString(String(value || ""), "text/html");
  return doc.body.textContent || "";
}

function escapeHTML(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHTML(value).replaceAll("`", "&#096;");
}

// Eventi UI: giocatori, ricerca, centratura mappa e azioni nei popup.
els.playerPicker.addEventListener("click", event => {
  const button = event.target.closest("[data-player-id]");
  if (!button) return;
  setActivePlayer(button.dataset.playerId);
});

els.searchInput.addEventListener("input", filterPubs);
els.fitBtn.addEventListener("click", () => fitToVisible());
els.clearBtn.addEventListener("click", () => {
  els.searchInput.value = "";
  filterPubs();
  fitToVisible();
});

document.addEventListener("click", event => {
  const button = event.target.closest("[data-game-action]");
  if (!button || button.disabled) return;
  const pubId = button.dataset.pubId;
  if (button.dataset.gameAction === "claim") {
    claimPub(pubId, button.dataset.playerId);
  } else if (button.dataset.gameAction === "unclaim") {
    unclaimPub(pubId);
  } else if (button.dataset.gameAction === "approve") {
    voteOnClaim(pubId, button.dataset.playerId, "approve");
  } else if (button.dataset.gameAction === "reject") {
    voteOnClaim(pubId, button.dataset.playerId, "reject");
  }
}, true);

els.results.addEventListener("click", event => {
  const card = event.target.closest(".card");
  if (!card) return;
  focusPub(card.dataset.id);
});

renderPlayerPicker();
updateCounters();

try {
  loadPubsFromAPI();
} catch (error) {
  console.error(error);
  setStatus("Errore iniziale nello script. Controlla la console del browser.", "bad");
}
