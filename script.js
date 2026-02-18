/* =====================================================================================
   O-RING / DOVETAIL GLAND ANALYZER — CLEAN SCRIPT (BLOCK 1 OF 3)
   Hybrid Documentation Style:
   - JSDoc for major systems
   - In-line comments for core logic paths
   - Clear section banners for maintainability
   ===================================================================================== */


/* =====================================================================================
   GLOBAL STATE & CONSTANTS
   ===================================================================================== */

/** File locations for AS568 data */
const AS568_MM_CSV_URL = "./data/as568_mm.csv";
const AS568_IN_CSV_URL = "./data/as568_in.csv";

/** Unit settings (length + temperature) */
let unit = "in";      // “in” | “mm”
let tempUnit = "°C";  // “°C” | “°F”

/** AS568 CSV caches */
let as568DataMM = null;
let as568DataIN = null;
let as568LoadedMM = false;
let as568LoadedIN = false;

/** AS568 modal state */
let as568Data = [];
let as568Filtered = [];
let as568SelectedIndex = -1;

/** Calculation state */
let hasCalculated = false;

/** Engineering constants */
const PI = Math.PI;
const IN_TO_MM = 25.4;
const AMBIENT = 23;        // canonical °C anchor
const ALPHA_DEFAULT = 316e-6;

/** Mandatory fields that must contain valid numeric input before calculation */
const mandatoryFields = [
  "glandWidth","glandDepth","glandAngle","glandTopR","glandBottomR",
  "gap","glandCenterline","oringCS","oringID",
  "alpha","oringMaterialGroup"
];

/** Material → CTE mapping */
const MATERIAL_TO_CTE = {
  "FFKM": { alpha: 0.00035 },
  "FKM":  { alpha: 0.00025 },
  "NBR":  { alpha: 0.000175 },
  "VMQ":  { alpha: 0.00021 },
  "HNBR": { alpha: 0.000175 },
  "EPDM": { alpha: 0.000175 },
  "PU":   { alpha: 0.000175 },
  "ACM":  { alpha: 0.00018 },
  "CR":   { alpha: 0.000185 },
  "FVMQ": { alpha: 0.00022 },
  "NR":   { alpha: 0.00018 },
  "IIR":  { alpha: 0.00013 },
  "SBR":  { alpha: 0.00018 }
};

/** Material → Hardness options */
const MATERIAL_TO_HARDNESS = {
  "NBR": ["70","90"],
  "FKM": ["70","90"],
  "EPDM": ["75"],
  "VMQ": ["70"]
};


/* =====================================================================================
   BASIC UTILITIES — Validation, Conversion, Formatting
   ===================================================================================== */

/** Debounce helper */
function debounce(fn, ms=250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/** Validate numeric mandatory inputs */
function isValidNumberField(inp) {
  if (!inp) return false;
  const v = inp.value.trim();
  if (v === "") return false;
  return Number.isFinite(Number(v));
}

/** Resolve current display unit for the given input */
function getInputUnit(inp) {
  if (inp.id === "alpha") return "";
  if (inp.classList.contains("temp-field")) return (tempUnit === "°F" ? "F" : "C");
  return unit; // “in” or “mm”
}

/** Convert between in↔mm and C↔F */
function convert(value, from, to) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "";
  if (from === to) return num;

  // Length
  if (from === "in" && to === "mm") return num * IN_TO_MM;
  if (from === "mm" && to === "in") return num / IN_TO_MM;

  // Temperature
  if (from === "C" && to === "F") return num * 9/5 + 32;
  if (from === "F" && to === "C") return (num - 32) * 5/9;

  return num;
}

/** α scientific notation formatter */
function toSci(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return n.toExponential(2).replace(/e\+?(-?\d+)/, "e$1");
}

/** Temperature field IDs */
const TEMP_IDS = new Set(["tempMin","tempNom","tempMax"]);
const isTempId = (id) => TEMP_IDS.has(id);


/* =====================================================================================
   RIGHT PANEL — IMAGE-ONLY MODE
   ===================================================================================== */

/**
 * Right-panel info updater (now a no-op).
 * The app still calls this in many places; we keep it safe and empty.
 */
function updateGlandInfoPanel() { /* no-op: image-only mode */ }

/**
 * Sets the placeholder image in the right panel.
 * Gracefully handles missing elements.
 */
function setGlandPlaceholder(url) {
  const img  = document.getElementById("glandPlaceholder");
  const hint = document.getElementById("glandPlaceholderHint");
  if (!img) return;

  if (url && typeof url === "string") {
    img.src = url;              // always forward slashes for web path
    img.alt = "Gland diagram placeholder";
    if (hint) hint.style.display = "none";
  } else {
    img.removeAttribute("src");
    img.alt = "Gland diagram placeholder (to be provided)";
    if (hint) hint.style.display = "block";
  }
}

/* =====================================================================================
   O-RING / DOVETAIL GLAND ANALYZER — CLEAN SCRIPT (BLOCK 2 OF 3)
   Session handling, input tracking, advisory, materials, refreshers, validation
   ===================================================================================== */


/* =====================================================================================
   SESSION STORAGE (localStorage)
   ===================================================================================== */

const LS_KEY = "gland_tool_v1";

/**
 * Persist inputs, their original values/units, and toggle states.
 * We keep “originals” so we can accurately re-render on unit/temperature switches.
 */
function saveSession() {
  const data = {};

  document.querySelectorAll("input.field, input.temp-field, select.dropdown")
    .forEach(el => {
      data[el.id] = {
        v:  el.value,
        ov: el.dataset.originalValue ?? "",
        ou: el.dataset.originalUnit ?? ""
      };
    });

  data.__unit = unit;
  data.__tempUnit = tempUnit;

  localStorage.setItem(LS_KEY, JSON.stringify(data));
}
const saveSessionDebounced = debounce(saveSession, 250);

/**
 * Normalize any saved temperature originals to canonical °C.
 * This guarantees fully reversible C↔F toggling (Option A).
 */
function normalizeTempOriginalsToC() {
  document.querySelectorAll(".temp-field").forEach(inp => {
    const ov = inp.dataset.originalValue;
    const ou = inp.dataset.originalUnit;
    if (ov === undefined || ov === "") return;

    if (ou === "F") {
      const c = convert(Number(ov), "F", "C");
      if (Number.isFinite(c)) {
        inp.dataset.originalValue = String(c);
        inp.dataset.originalUnit  = "C";
      }
    } else if (ou !== "C") {
      inp.dataset.originalUnit = "C";
    }
  });
}

/**
 * Load persisted state; restore toggles; restore inputs; normalize temps to °C;
 * then re-render the UI.
 */
function loadSession() {
  const raw = localStorage.getItem(LS_KEY);
  if (!raw) return;

  try {
    const data = JSON.parse(raw);

    // Restore toggles
    if (data.__unit) unit = data.__unit;
    if (data.__tempUnit) tempUnit = data.__tempUnit;

    document.querySelectorAll(".unit-toggle .toggle-btn")
      .forEach(b => b.classList.toggle("active", b.dataset.val === unit));

    document.querySelectorAll(".temp-toggle .toggle-btn")
      .forEach(b => {
        const isF = b.dataset.val === "f";
        b.classList.toggle("active", (isF ? "°F" : "°C") === tempUnit);
      });

    document.querySelectorAll(".temp-unit-final")
      .forEach(x => x.textContent = tempUnit);

    // Restore input values + stored “originals”
    Object.keys(data).forEach(id => {
      if (id.startsWith("__")) return;
      const el = document.getElementById(id);
      if (!el) return;
      el.value = data[id].v ?? "";
      el.dataset.originalValue = data[id].ov ?? "";
      el.dataset.originalUnit  = data[id].ou ?? "";
    });

    // Canonicalize all temperature originals to °C for true reversible toggling.
    normalizeTempOriginalsToC();

    applyMaterialMapping();
    refreshDisplayValues();
    updateUnitLabels();
    checkMandatoryStatus();
    updateGlandInfoPanel();  // safe no-op (image-only mode)

  } catch (e) {
    console.warn("Failed to parse saved session:", e);
  }
}


/* =====================================================================================
   ADVISORY SYSTEM (inline non-blocking hints)
   ===================================================================================== */

const HINTS = {
  glandWidth:     { min: -Infinity, warnMin: 0, msg: "Width is negative; verify sign." },
  glandDepth:     { min: -Infinity, warnMin: 0, msg: "Depth is negative; verify sign." },
  glandAngle:     { min: -180, max: 180, msg: "Angle should be within -180° to 180°." },
  glandTopR:      { min: -Infinity, warnMin: 0, msg: "Radius is negative; verify." },
  glandBottomR:   { min: -Infinity, warnMin: 0, msg: "Radius is negative; verify." },
  gap:            { min: -Infinity, warnMin: 0, msg: "Gap is negative; verify." },
  glandCenterline:{ min: -Infinity, warnMin: 0, msg: "Centerline is negative; verify." },
  oringCS:        { min: -Infinity, warnMin: 0, msg: "Cross‑section is negative; verify." },
  oringID:        { min: -Infinity, warnMin: 0, msg: "O‑ring ID is negative; verify." },
  alpha:          { min: 0, msg: "CTE should normally be ≥ 0. Check units/value." },
  tempMin:  {},
  tempNom:  {},
  tempMax:  {},
};

/** Show/hide per-field hint with error/warn styling */
function showHint(id, state, text) {
  const input = document.getElementById(id);
  const hint  = document.getElementById(`hint_${id}`);
  if (!input || !hint) return;

  input.classList.remove("is-invalid", "is-warn");
  hint.classList.remove("warn");

  if (!state) { hint.style.display = "none"; return; }

  if (state === "invalid") {
    input.classList.add("is-invalid");
    hint.textContent = text || "Please enter a numeric value.";
    hint.style.display = "block";
  } else if (state === "warn") {
    input.classList.add("is-warn");
    hint.textContent = text || "Please verify.";
    hint.classList.add("warn");
    hint.style.display = "block";
  }
}

/** Evaluate a field against advisory thresholds and render hint */
function advisoryCheck(id) {
  const cfg = HINTS[id]; if (!cfg) return;
  const el  = document.getElementById(id); if (!el) return;

  const raw = el.value.trim();
  if (raw === "") { showHint(id, null); return; }

  const n = Number(raw);
  if (!Number.isFinite(n)) { showHint(id,"invalid","Please enter a numeric value."); return; }
  if (cfg.min !== undefined && n < cfg.min) { showHint(id,"invalid",cfg.msg); return; }
  if (cfg.max !== undefined && n > cfg.max) { showHint(id,"invalid",cfg.msg); return; }
  if (cfg.warnMin !== undefined && n < cfg.warnMin) { showHint(id,"warn",cfg.msg); return; }

  showHint(id, null);
}


/* =====================================================================================
   INPUT TRACKING (store originals exactly once)
   -------------------------------------------------------------------------------------
   - Temp fields: store originals CANONICALLY in °C (for reversible C↔F).
   - Other numerics: store original value + the display unit (“in|mm”).
   - Alpha: store raw text (format to sci on blur only).
   ===================================================================================== */

function attachInputTracking() {
  const numberInputs = document.querySelectorAll("input.field, input.temp-field");

  numberInputs.forEach(inp => {
    inp.addEventListener("input", () => {

      if (mandatoryFields.includes(inp.id) && hasCalculated) resetResultsOnly();

      const raw = inp.value;
      if (raw.trim() === "") {
        inp.dataset.originalValue = "";
        inp.dataset.originalUnit  = "";
        checkMandatoryStatus();
        saveSessionDebounced();
        updateGlandInfoPanel();
        return;
      }

      // α: store raw; sci formatting on blur only
      if (inp.id === "alpha") {
        inp.dataset.originalValue = raw;
        inp.dataset.originalUnit  = "";
        checkMandatoryStatus();
        saveSessionDebounced();
        updateGlandInfoPanel();
        return;
      }

      // Limit decimals cosmetically while typing
      let val = raw;
      if (val.includes(".")) {
        const [a,b] = val.split(".");
        val = a + "." + b.slice(0,3);
      }
      const num = Number(val);
      if (!Number.isFinite(num)) {
        inp.dataset.originalValue = "";
        inp.dataset.originalUnit  = "";
        checkMandatoryStatus();
        saveSessionDebounced();
        updateGlandInfoPanel();
        return;
      }

      if (isTempId(inp.id)) {
        // Store temperature originals always in °C
        const displayU = getInputUnit(inp);  // "C" | "F"
        const c = convert(num, displayU, "C");
        if (Number.isFinite(c)) {
          inp.dataset.originalValue = String(c);
          inp.dataset.originalUnit  = "C";
        }
      } else {
        // Store other numerics with their current display unit
        inp.dataset.originalValue = String(num);
        inp.dataset.originalUnit  = getInputUnit(inp);  // "in" | "mm"
      }

      checkMandatoryStatus();
      saveSessionDebounced();
      updateGlandInfoPanel(); // image-only, safe no-op
    });

    // BLUR rules
    inp.addEventListener("blur", () => {
      const orig = inp.dataset.originalValue;

      if (inp.id === "alpha") {
        if (orig !== "" && orig !== undefined) inp.value = toSci(orig);
        saveSessionDebounced();
        updateGlandInfoPanel();
        return;
      }

      // Angle: keep exactly as typed; Temp: don’t reformat on blur
      if (inp.id === "glandAngle" || isTempId(inp.id)) {
        saveSessionDebounced();
        updateGlandInfoPanel();
        return;
      }

      // All others → 3 decimals (cosmetic)
      if (orig !== "" && orig !== undefined) {
        inp.value = Number(orig).toFixed(3);
        saveSessionDebounced();
      }
      updateGlandInfoPanel();
    });
  });

  // Attach advisory listeners
  Object.keys(HINTS).forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const fn = () => { advisoryCheck(id); saveSessionDebounced(); updateGlandInfoPanel(); };
    el.addEventListener("input", fn);
    el.addEventListener("blur", fn);
  });

  // Selects
  document.querySelectorAll("select.dropdown").forEach(sel => {
    sel.addEventListener("change", () => {
      sel.dataset.originalValue = sel.value;
      sel.dataset.originalUnit  = "";

      if (sel.id === "oringMaterialGroup") {
        if (hasCalculated) resetResultsOnly();
        applyMaterialMapping();
      }

      checkMandatoryStatus();
      saveSessionDebounced();
      updateGlandInfoPanel();
    });
  });
}


/* =====================================================================================
   MATERIAL MAPPING (CTE & Hardness)
   ===================================================================================== */

function applyMaterialMapping() {
  const matSel  = document.getElementById("oringMaterialGroup");
  const mat     = matSel.value;
  const alphaInp= document.getElementById("alpha");
  const alphaApp= document.getElementById("alphaAppDisplay");
  const hardSel = document.getElementById("oringHardness");

  const map = MATERIAL_TO_CTE[mat];

  if (map) {
    alphaInp.dataset.originalValue = String(map.alpha);
    alphaInp.dataset.originalUnit  = "";
    alphaInp.value = toSci(map.alpha);
    alphaApp.textContent = "";
  } else {
    alphaInp.value="";
    alphaInp.dataset.originalValue="";
    alphaInp.dataset.originalUnit="";
    alphaApp.textContent="";
  }

  const list = MATERIAL_TO_HARDNESS[mat];
  hardSel.innerHTML="";
  if (list && list.length) {
    hardSel.disabled = false;
    const opt0 = document.createElement("option");
    opt0.value=""; opt0.textContent="Select";
    hardSel.appendChild(opt0);
    list.forEach(h => {
      const o=document.createElement("option");
      o.value=h; o.textContent=h;
      hardSel.appendChild(o);
    });
  } else {
    hardSel.disabled = true;
    const o=document.createElement("option");
    o.value=""; o.textContent="–";
    hardSel.appendChild(o);
  }

  updateGlandInfoPanel(); // safe no-op
}


/* =====================================================================================
   REFRESHERS (on unit/temperature toggle) & LABELS
   ===================================================================================== */

/**
 * Re-render visible input values from stored originals.
 * - Temps: originals canonical °C → convert to display (C/F), 2 decimals.
 * - Angle: keep as typed.
 * - Others: convert (in/mm), 3 decimals.
 */
function refreshDisplayValues() {
  document.querySelectorAll("input.field, input.temp-field").forEach(inp => {
    const ov = inp.dataset.originalValue;
    const ou = inp.dataset.originalUnit;
    if (ov === undefined || ov === "") return;

    // α → scientific
    if (inp.id === "alpha") {
      inp.value = toSci(ov);
      return;
    }

    // Temperature fields (from canonical °C)
    if (isTempId(inp.id)) {
      const displayU = getInputUnit(inp); // "C" | "F"
      const val      = convert(Number(ov), (ou || "C"), displayU);
      inp.value = Number(val).toFixed(2);
      return;
    }

    // Angle: keep as typed on refresh (no enforced format)
    if (inp.id === "glandAngle") return;

    // Others: convert using original unit → display unit (in/mm)
    const displayUnit = getInputUnit(inp);
    const val = convert(Number(ov), ou, displayUnit);
    inp.value = Number(val).toFixed(3);
  });

  if (hasCalculated) renderLastResults();
  updateGlandInfoPanel(); // safe no-op
}

/** Flip “in/mm” stamps; temperature unit stamps are handled by the temp toggle */
function updateUnitLabels() {
  // Author-marked unit labels
  document.querySelectorAll(".unit-lbl").forEach(el => { el.textContent = unit; });

  // Any literal “in/mm” text nodes
  document.querySelectorAll(".unit-text").forEach(el => {
    const t = (el.textContent || "").trim().toLowerCase();
    if (t === "in" || t === "mm") el.textContent = unit;
  });
}


/* =====================================================================================
   VALIDATION GATE (enable/disable Calculate)
   ===================================================================================== */

function checkMandatoryStatus() {
  let valid=true;

  for (const id of mandatoryFields) {
    if (id==="oringMaterialGroup") {
      const sel=document.getElementById("oringMaterialGroup");
      if (!sel || !sel.value) { valid=false; break; }
      continue;
    }
    if (!isValidNumberField(document.getElementById(id))) {
      valid=false; break;
    }
  }

  const btn = document.getElementById("calculateBtn");
  if (!btn) return;
  btn.disabled = !valid;
  btn.classList.toggle("disabled", !valid);
}

/* =====================================================================================
   O-RING / DOVETAIL GLAND ANALYZER — CLEAN SCRIPT (BLOCK 3 OF 3)
   Calculations, Warnings/Alerts banners, AS568 modal, Results, Init, Reset
   ===================================================================================== */


/* =====================================================================================
   ENGINEERING CORE (geometry & performance)
   ===================================================================================== */

/** Circular segment area used in corner geometry */
function circularSegmentArea(r, angle){
  const theta = angle * PI/180;
  const h = r * (1 - Math.cos(theta/2));
  if (h <= 0) return 0;
  return r*r*Math.acos((r-h)/r) - (r-h)*Math.sqrt(2*r*h - h*h);
}

/** Dovetail cross-section area (simplified model) */
function dovetailCrossSection(gw, gd, ang, rTop, rBottom, gap){
  const angRad = ang * PI/180;
  const topWidth = gw + 2 * (gd / Math.tan(angRad));
  const A_trap   = 0.5 * (gw + topWidth) * gd;
  const A_top    = 2 * circularSegmentArea(rTop, ang);
  const A_bottom = 2 * circularSegmentArea(rBottom, ang);
  const A_gap    = (gw + 2*rTop) * gap;
  return A_trap + A_top - A_bottom + A_gap;
}

/**
 * Master calculation
 * Returns: stretch %, gland volume, and per-temperature compression & fill
 */
function calculateDovetail(p, tempsList){
  const temps = tempsList.length ? tempsList : [AMBIENT];

  const stretchPct = ((p.centerline - (p.id + p.cs)) / (p.id + p.cs)) * 100;

  // Approximate O-ring volume (torus)
  const r = p.cs/2, R = (p.id + p.cs)/2;
  const oringVolume = 2 * PI * PI * r * r * R;

  // Gland volume (2D area × circumferential length)
  const crossArea = dovetailCrossSection(p.gw, p.gd, p.angle, p.rTop, p.rBottom, p.gap);
  const glandVolume = crossArea * PI * p.centerline;

  const results = temps.map(tempC => {
    const dT = tempC - AMBIENT;
    const expandedCS = p.cs * (1 + p.alpha * dT);
    const expandedVol = oringVolume * (1 + 3*p.alpha*dT);
    return {
      tempC,
      compressionPct: (1 - (p.gd / expandedCS)) * 100,
      glandFillPct: (expandedVol / glandVolume) * 100
    };
  });

  return { stretchPct, glandVolume, temperatureResults: results };
}

/** Warning rules (engineering) */
function evaluateWarnings(out){
  const warn = [];

  if (out.stretchPct < 0) warn.push("O‑ring is loose (negative stretch).");
  else if (out.stretchPct > 5) warn.push("Stretch exceeds recommended 5%.");

  out.temperatureResults.forEach(t => {
    if (t.compressionPct < 15) warn.push(`Compression ${t.tempC}°C < 15%`);
    if (t.compressionPct > 30) warn.push(`Compression ${t.tempC}°C > 30%`);
    if (t.glandFillPct > 95)   warn.push(`Gland fill ${t.tempC}°C > 95%`);
  });

  return warn;
}

/** Read a temperature field's original value in °C (originals are canonical °C) */
function readTempC(id){
  const inp=document.getElementById(id);
  if (!inp || !inp.dataset.originalValue) return NaN;
  const val = Number(inp.dataset.originalValue);
  const u   = (inp.dataset.originalUnit || "C");
  const c = convert(val, u, "C");
  return Number.isFinite(c) ? c : NaN;
}


/* =====================================================================================
   WARNINGS (RED) & ALERTS (AMBER) BANNERS — renderers
   ===================================================================================== */

/** Render engineering warnings into the RED banner */
function renderWarningsBanner(msgs = []) {
  const box = document.getElementById("warningsBanner");
  if (!box) return;
  if (!msgs.length) {
    box.style.display = "none";
    box.innerHTML = "";
    return;
  }
  box.style.display = "block";
  box.innerHTML = msgs.map(m =>
    `<div class="warn-item"><span class="warn-icon">❗</span><span>${m}</span></div>`
  ).join("");
}

/** Render advisory alerts into the AMBER banner */
function renderAlertsBanner(msgs = []) {
  const box = document.getElementById("alertsBanner");
  if (!box) return;
  if (!msgs.length) {
    box.style.display = "none";
    box.innerHTML = "";
    return;
  }
  box.style.display = "block";
  box.innerHTML = msgs.map(m =>
    `<div class="alert-item"><span class="alert-icon">⚠️</span><span>${m}</span></div>`
  ).join("");
}

/** Pre-calc RED warnings (block calculation if any) */
function collectPrecalcWarnings() {
  const issues = [];

  // Material group must be chosen
  const sel = document.getElementById("oringMaterialGroup");
  if (!sel || !sel.value) issues.push("Missing material group.");

  // All mandatory numeric fields must be valid
  const invalids = [];
  mandatoryFields.forEach(id => {
    if (id === "oringMaterialGroup") return;
    const el = document.getElementById(id);
    if (!isValidNumberField(el)) invalids.push(id);
  });
  if (invalids.length) issues.push("Missing/invalid mandatory numbers.");

  return issues;
}

/** Nominal compression outside 20–25% band (RED warning) */
function collectNominalCompressionWarning(nominalEntry) {
  if (!nominalEntry) return [];
  const c = nominalEntry.compressionPct;
  return (c >= 20 && c <= 25) ? [] : [`Nominal compression ${c.toFixed(2)}% is outside the 20–25% band.`];
}


/* =====================================================================================
   AS568 LOADER + MODAL (parse, load, filter, select)
   ===================================================================================== */

function parseAs568Csv(text){
  const t = text.replace(/^\uFEFF/,"").trim();
  if (!t) return [];

  const lines = t.split(/\r?\n/);
  const headerLine = lines.shift();
  const header = (headerLine || "").split(",").map(h => h.trim().toLowerCase());

  const find = (arr)=> arr.map(k=>header.indexOf(k)).find(i=>i!==-1);
  const iDash = find(["dash","dash size"]);
  const iCS   = find(["cs","o-ring cross section size","o-ring cross section"]);
  const iID   = find(["id","o-ring internal diameter size","o-ring internal diameter"]);

  const rows = [];

  for (const line of lines){
    if (!line.trim()) continue;
    const cols = line.split(",").map(v=>v.trim());
    if (cols.length <= Math.max(iDash, iCS, iID)) continue;

    const dash = cols[iDash];
    const cs = Number(cols[iCS]);
    const id = Number(cols[iID]);
    if (!dash || !Number.isFinite(cs) || !Number.isFinite(id)) continue;

    rows.push({ dash, cs, id });
  }

  rows.sort((a,b)=> (a.dash||"").localeCompare((b.dash||""), "en", {numeric:true}));
  return rows;
}

async function loadAs568Csv(url, isMM){
  const resp = await fetch(url, { cache:"no-store" });
  const txt = await resp.text();
  const parsed = parseAs568Csv(txt);
  if (isMM) { as568DataMM = parsed; as568LoadedMM = true; }
  else      { as568DataIN = parsed; as568LoadedIN = true; }
}

async function loadAs568Data(){
  if (!as568LoadedMM) await loadAs568Csv(AS568_MM_CSV_URL, true);
  if (!as568LoadedIN) await loadAs568Csv(AS568_IN_CSV_URL, false);
  return (unit === "mm") ? as568DataMM : as568DataIN;
}

function renderAs568Table(){
  const tbody=document.getElementById("as568Tbody");
  if (!tbody) return;

  tbody.innerHTML="";
  as568SelectedIndex=-1;

  const addBtn = document.getElementById("as568AddBtn");
  if (addBtn) addBtn.disabled=true;

  as568Filtered.forEach((row, idx)=>{
    const tr=document.createElement("tr");
    tr.innerHTML = `
      <td>${row.dash}</td>
      <td>${row.cs}</td>
      <td>${row.id}</td>
    `;
    tr.addEventListener("click", ()=>{
      tbody.querySelectorAll("tr").forEach(r=>r.classList.remove("selected"));
      tr.classList.add("selected");
      as568SelectedIndex = idx;
      if (addBtn) addBtn.disabled=false;
    });
    tbody.appendChild(tr);
  });
}

function filterAs568Table(query){
  const q = query.toLowerCase().trim();
  as568Filtered = as568Data.filter(r =>
    (r.dash || "").toLowerCase().includes(q) ||
    String(r.cs).includes(q) ||
    String(r.id).includes(q)
  );
  renderAs568Table();
}

async function openAs568Modal(){
  as568Data = await loadAs568Data();
  as568Filtered = [...as568Data];
  renderAs568Table();

  const modal = document.getElementById("as568Modal");
  if (modal) modal.style.display="block";

  const search=document.getElementById("as568Search");
  if (search) { search.value=""; search.focus(); }
}

function closeAs568Modal(){
  const modal = document.getElementById("as568Modal");
  if (modal) modal.style.display="none";
}

function applyAs568Selection(){
  if (as568SelectedIndex < 0) return;

  const row = as568Filtered[as568SelectedIndex];

  const csField=document.getElementById("oringCS");
  const idField=document.getElementById("oringID");

  if (hasCalculated) resetResultsOnly();

  if (csField) {
    csField.dataset.originalValue = row.cs;
    csField.dataset.originalUnit  = unit;
    csField.value = Number(row.cs).toFixed(3);
  }
  if (idField) {
    idField.dataset.originalValue = row.id;
    idField.dataset.originalUnit  = unit;
    idField.value = Number(row.id).toFixed(3);
  }

  checkMandatoryStatus();
  saveSessionDebounced();
  updateGlandInfoPanel();
  closeAs568Modal();
}


/* =====================================================================================
   RESULTS RENDERING (cards)
   ===================================================================================== */

let _lastRender = null;

/** Build results cards; clamp stretch display to >= 0 */
function renderResultsGrid(out, meta, stretchPct){
  const grid=document.getElementById("resultsGrid");
  if (!grid) return;
  grid.innerHTML="";

  const toDisp = tempC =>
    (tempUnit==="°F")
      ? `${convert(tempC,"C","F").toFixed(2)} °F`
      : `${tempC.toFixed(2)} °C`;

  // Ambient / Nominal card
  if (meta.ambient) {
    const t = meta.ambient;
    // Class for Stretch: red (oob) if negative; else normal.
    // Display for Stretch is clamped at 0.00 if negative (as requested).
    const sCls = (out.stretchPct < 0) ? "oob" : "";

    // Compression: red if outside 20–25% band OR negative.
    // Display: clamp at 0.00 if negative, otherwise show actual.
    const isCompNeg = (t.compressionPct < 0);
    const cDisplay  = (isCompNeg ? 0 : t.compressionPct);
    const cCls      = (isCompNeg || !(t.compressionPct >= 20 && t.compressionPct <= 25)) ? "oob" : "";

    // Gland Fill: red if >95% OR negative.
    // Display: clamp at 0.00 if negative, otherwise show actual.
    const isFillNeg = (t.glandFillPct < 0);
    const fDisplay  = (isFillNeg ? 0 : t.glandFillPct);
    const fCls      = (isFillNeg || !(t.glandFillPct <= 95)) ? "oob" : "";

    const card = document.createElement("div");
    card.className = "results-panel";
    card.innerHTML = `
      <div class="results-header">Ambient Temperature (23 °C)</div>
      <!--<div class="results-subheader">Nominal</div>-->
      <div class="results-row"><span>Stretch</span><span class="${sCls}">${Math.max(0, stretchPct).toFixed(2)}%</span></div>
      <div class="results-row"><span>Compression</span><span class="${cCls}">${cDisplay.toFixed(2)}%</span></div>
      <div class="results-row"><span>Gland Fill</span><span class="${fCls}">${fDisplay.toFixed(2)}%</span></div>
    `;
    grid.appendChild(card);
  }

  // Operating temp cards
  function addOpCard(label, entry){
    if (!entry) return;
  
    // Compression: red if outside 20–25% or negative; clamp negatives to 0.00
    const compNeg = (entry.compressionPct < 0);
    const compDisp= compNeg ? 0 : entry.compressionPct;
    const cCls    = (compNeg || !(entry.compressionPct >= 20 && entry.compressionPct <= 25)) ? "oob" : "";
  
    // Gland Fill: red if >95% or negative; clamp negatives to 0.00
    const fillNeg = (entry.glandFillPct < 0);
    const fillDisp= fillNeg ? 0 : entry.glandFillPct;
    const fCls    = (fillNeg || !(entry.glandFillPct <= 95)) ? "oob" : "";
  
    const card = document.createElement("div");
    card.className = "results-panel";
    card.innerHTML = `
      <div class="results-header">Operating Temperature (${label}) ${toDisp(entry.tempC)}</div>
      <div class="results-row"><span>Compression</span><span class="${cCls}">${compDisp.toFixed(2)}%</span></div>
      <div class="results-row"><span>Gland Fill</span><span class="${fCls}">${fillDisp.toFixed(2)}%</span></div>
    `;
    grid.appendChild(card);
  }

  addOpCard("Min", meta.min);
  addOpCard("Nominal", meta.nominal);
  addOpCard("Max", meta.max);
}


/* =====================================================================================
   CALCULATION ENTRY POINT (banners, no popups)
   ===================================================================================== */

/** Run the calculation flow; use RED/AMBER banners for issues */
function runCalculation(){

  // 1) Pre-calc warnings (RED); block and do not compute
  const precalc = collectPrecalcWarnings();
  if (precalc.length) {
    renderWarningsBanner(precalc);
    renderAlertsBanner([]);
    const grid = document.getElementById("resultsGrid");
    if (grid) grid.innerHTML = "";
    hasCalculated = false;
    const exportBtn=document.getElementById("exportBtn");
    if (exportBtn) { exportBtn.disabled = true; exportBtn.classList.add("disabled"); }
    return;
  }

  // 2) Gather inputs from originals
  const readOrig = id => {
    const el=document.getElementById(id);
    return Number(el?.dataset.originalValue);
  };

  const params = {
    cs: readOrig("oringCS"),
    id: readOrig("oringID"),
    gw: readOrig("glandWidth"),
    gd: readOrig("glandDepth"),
    angle: Number(document.getElementById("glandAngle").value),
    rTop: readOrig("glandTopR"),
    rBottom: readOrig("glandBottomR"),
    gap: readOrig("gap"),
    centerline: readOrig("glandCenterline"),
    alpha: Number(document.getElementById("alpha").value) || ALPHA_DEFAULT
  };

  // 3) Build temperature list (canonical °C)
  const tAmbientC = AMBIENT;
  const tMinC = readTempC("tempMin");
  const tNomC = readTempC("tempNom");
  const tMaxC = readTempC("tempMax");

  const temps = [tAmbientC];
  if (Number.isFinite(tMinC)) temps.push(tMinC);
  if (Number.isFinite(tNomC)) temps.push(tNomC);
  if (Number.isFinite(tMaxC)) temps.push(tMaxC);

  const uniqSorted = [...new Set(temps.slice(1))].sort((a,b)=>a-b);
  const tempsFinal = [tAmbientC, ...uniqSorted];

  // 4) Compute
  const out = calculateDovetail(params, tempsFinal);

  // 5) Build meta map for cards
  const meta = {};
  out.temperatureResults.forEach(e => { if (e.tempC===tAmbientC) meta.ambient = e; });
  if (Number.isFinite(tMinC)) meta.min     = out.temperatureResults.find(e=>e.tempC===tMinC);
  if (Number.isFinite(tNomC)) meta.nominal = out.temperatureResults.find(e=>e.tempC===tNomC);
  if (Number.isFinite(tMaxC)) meta.max     = out.temperatureResults.find(e=>e.tempC===tMaxC);

  // 6) RED/AMBER banners before results
  const redWarnings = [
    ...evaluateWarnings(out),
    ...collectNominalCompressionWarning(meta.nominal)
  ];
  renderWarningsBanner(redWarnings);

  // For now, no amber alerts; framework ready if you want advisory items
  renderAlertsBanner([]);

  // 7) Render results
  renderResultsGrid(out, meta, out.stretchPct);

  // 8) Bookkeeping
  _lastRender = { out, meta };
  hasCalculated = true;

  const exportBtn=document.getElementById("exportBtn");
  if (exportBtn) { exportBtn.disabled=false; exportBtn.classList.remove("disabled"); }

  updateGlandInfoPanel(); // safe no-op
  saveSessionDebounced();
}

/** Re-render results and banners after unit/temperature changes */
function renderLastResults(){
  if (!_lastRender) return;
  const { out, meta } = _lastRender;

  const redWarnings = [
    ...evaluateWarnings(out),
    ...collectNominalCompressionWarning(meta.nominal)
  ];
  renderWarningsBanner(redWarnings);
  renderAlertsBanner([]);

  renderResultsGrid(out, meta, out.stretchPct);
}


/* =====================================================================================
   EXPORT
   ===================================================================================== */

function exportPDF(){ window.print(); }


/* =====================================================================================
   INITIALIZATION (DOMContentLoaded)
   ===================================================================================== */

document.addEventListener("DOMContentLoaded", () => {

  // 1) Input tracking (sets dataset.originalValue/Unit correctly)
  attachInputTracking();

  // 2) Restore previous session (also normalizes temp originals to C)
  loadSession();

  // 3) Right-panel image (web path; forward slashes)
  setGlandPlaceholder("assets/gland-placeholder.png");

  // 4) UNIT TOGGLE
  document.querySelectorAll(".unit-toggle .toggle-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".unit-toggle .toggle-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");

      unit = btn.dataset.val;         // "in" | "mm"

      refreshDisplayValues();          // convert visible values
      updateUnitLabels();              // flip labels
      checkMandatoryStatus();
      saveSessionDebounced();
      updateGlandInfoPanel();          // safe no-op
    });
  });

  // 5) TEMPERATURE TOGGLE (Option A: fully reversible)
  document.querySelectorAll(".temp-toggle .toggle-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".temp-toggle .toggle-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");

      tempUnit = (btn.dataset.val === "f") ? "°F" : "°C";

      // Update legend/stamp (UI only)
      document.querySelectorAll(".temp-unit-final").forEach(x => x.textContent = tempUnit);

      // Originals are canonical °C — just refresh to re-render converted display
      refreshDisplayValues();

      checkMandatoryStatus();
      saveSessionDebounced();
      updateGlandInfoPanel(); // safe no-op
    });
  });

  // 6) AS568 modal controls (guarded)
  document.getElementById("openAs568Btn")?.addEventListener("click", openAs568Modal);
  document.getElementById("as568CancelBtn")?.addEventListener("click", closeAs568Modal);
  document.getElementById("as568AddBtn")?.addEventListener("click", applyAs568Selection);
  document.getElementById("as568Search")?.addEventListener("input", e => filterAs568Table(e.target.value));
  document.addEventListener("keydown", (e) => { if (e.key==="Escape") closeAs568Modal(); });

  // 7) Export button (guarded)
  const exportBtn=document.getElementById("exportBtn");
  if (exportBtn) {
    exportBtn.disabled=true;
    exportBtn.classList.add("disabled");
    exportBtn.addEventListener("click", exportPDF);
  }

  // 8) Primary actions (guarded)
  document.getElementById("calculateBtn")?.addEventListener("click", runCalculation);
  document.getElementById("resetBtn")?.addEventListener("click", resetForm);

  // 9) First pass UI sync
  updateUnitLabels();
  checkMandatoryStatus();
  updateGlandInfoPanel(); // safe no-op
});


/* =====================================================================================
   RESET HANDLING
   ===================================================================================== */

function resetResultsOnly() {
  // Clear banners
  renderWarningsBanner([]);
  renderAlertsBanner([]);

  // Clear result cards
  const grid = document.getElementById("resultsGrid");
  if (grid) grid.innerHTML = "";

  hasCalculated = false;

  const exportBtn=document.getElementById("exportBtn");
  if (exportBtn) {
    exportBtn.disabled = true;
    exportBtn.classList.add("disabled");
  }
}

function resetForm() {
  document.querySelectorAll("input[type='number'], select.dropdown").forEach(i => {
    i.value="";
    i.dataset.originalValue="";
    i.dataset.originalUnit="";
    i.disabled=false;
  });

  const alphaDisp = document.getElementById("alphaAppDisplay");
  if (alphaDisp) alphaDisp.textContent = "";

  resetResultsOnly();
  checkMandatoryStatus();
  saveSessionDebounced();
  updateGlandInfoPanel(); // safe no-op
}


/* =====================================================================================
   [COMMENTED — RETAINED] ACCORDION CODE (NOT EXECUTED)
   -------------------------------------------------------------------------------------
   // The accordion UI is removed from the DOM for now.
   // We keep the implementation here commented for future reuse.
   //
   // function initGlandAccordion() {
   //   const acc = document.getElementById("glandAccordion");
   //   if (!acc) return;
   //   const buttons = acc.querySelectorAll(".acc-head");
   //   if (!buttons.length) return;
   //
   //   // Default-open the first section
   //   const firstBtn   = buttons[0];
   //   const firstPanel = document.getElementById(firstBtn.getAttribute("aria-controls"));
   //   if (firstPanel) {
   //     firstBtn.setAttribute("aria-expanded", "true");
   //     firstPanel.hidden = false;
   //     const icon = firstBtn.querySelector(".acc-icon");
   //     if (icon) icon.textContent = "−";
   //   }
   //
   //   // Toggle handler
   //   buttons.forEach(btn => {
   //     btn.addEventListener("click", () => {
   //       const expanded = btn.getAttribute("aria-expanded") === "true";
   //       const panelId  = btn.getAttribute("aria-controls");
   //       const panel    = document.getElementById(panelId);
   //       const icon     = btn.querySelector(".acc-icon");
   //
   //       btn.setAttribute("aria-expanded", String(!expanded));
   //       if (panel) panel.hidden = expanded;
   //       if (icon)  icon.textContent = expanded ? "+" : "−";
   //     });
   //   });
   // }
   ===================================================================================== */
