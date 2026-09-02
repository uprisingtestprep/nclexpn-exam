/* NCLEXPN Exam Simulator, Application Logic */

const ACCESS_CODE  = "NCLEXPN9000";
const EXAM_SECONDS = 18000;
const PASSING_PCT  = 70;
const STORAGE_KEY  = "nclexpn_exam_state_v1";
const SIM_Q_COUNT  = 100;  // simulator serves this project's configured pool size (config.json exam.sim_questions)
const CLUSTER_LABEL = "Case Study";
const DOMAIN_LABELS = {"coordinated_care": "Coordinated Care", "safety_and_infection_prevention_and_control": "Safety and Infection Prevention and Control", "health_promotion_and_maintenance": "Health Promotion and Maintenance", "psychosocial_integrity": "Psychosocial Integrity", "basic_care_and_comfort": "Basic Care and Comfort", "pharmacological_therapies": "Pharmacological Therapies", "reduction_of_risk_potential": "Reduction of Risk Potential", "physiological_adaptation": "Physiological Adaptation"};  // maps domain key -> human-readable label for display
function domainLabel(key) { return DOMAIN_LABELS[key] || key || ""; }

// NCLEX-PN's real item types, per ITEM_TYPE_SCHEMAS.md at the project root
// (the single source of truth every script in this project agrees with):
//   "mcq"          default, single-select A-D
//   "sata"         extended multiple response (checklist), 2+ correct over
//                  4-7 options, scored as an exact set
//   "dropdown"     schema-identical to mcq (single letter 'correct') -- only
//                  the WIDGET differs, a <select> instead of a click list
//   "dragdrop"     extended drag and drop: 'items' is the scrambled list,
//                  each of up to 4 'options' is one CANDIDATE FULL ORDERING
//                  written as connected text, 'correct' names the letter of
//                  the option matching the true order
//   "hotspot_text" enhanced hot spot / highlighting: 'passage' holds text
//                  with candidate phrases marked [[LETTER|phrase]], 'options'
//                  holds the same phrases keyed by letter, 'correct' is a
//                  list of letters scored as an exact set (a close sibling of
//                  sata, differing only by rendering the phrases inside a
//                  passage instead of a standalone list)
//   "cloze"        multi-blank drop-down within one stem: 'blanks' is an
//                  ordered list of mcq-shaped {options} objects, 'correct' is
//                  a POSITIONAL list of letters (one per blank, in order)
//   "matrix"       matrix/grid: 'columns' + 'rows' ({id, text}), 'correct' is
//                  a dict {row_id: column_label}, every row must match for
//                  full credit
//   "bowtie"       5-part clinical judgment bowtie: 'parts' is an ordered
//                  list of 5 mcq-shaped {key, label, options} objects,
//                  'correct' is a dict {part_key: letter}, scored per part
function qType(q) {
  return q?.type || "mcq";
}

function optionLetters(q) {
  return Object.keys(q?.options || {}).sort();
}

let questions = [];
let state = {
  phase: "gate", answers: {}, flags: {},
  current: 1, timeLeft: EXAM_SECONDS,
  submitted: false, startTime: null,
};
let timerInterval = null;

// ── boot ──────────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  const allQ = (window.EXAM_QUESTIONS || []).slice();
  questions = pickQuestions(allQ, SIM_Q_COUNT);
  restoreState();

  document.getElementById("access-gate").style.display = "flex";
  document.getElementById("app").style.display = "none";
  setupAccessGate();
});

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// A question's "correct" is a single letter for mcq/dropdown/dragdrop, a list
// of letters for sata/hotspot_text, a positional list of letters for cloze,
// or a dict for matrix/bowtie. Normalize to a comparable string key so a run
// of identical correct-answers can be detected regardless of shape.
function correctKey(q) {
  const c = q.correct;
  if (Array.isArray(c)) return JSON.stringify(c.slice().sort());
  if (c && typeof c === "object") return JSON.stringify(Object.keys(c).sort().map(k => [k, c[k]]));
  return c;
}

// Shuffle by UNIT, never by individual question. A cluster is several
// questions sharing one case or passage: they must stay together and in their
// authored order, because later questions refer back to the same material.
// Shuffling every question individually scatters them across the exam, so a
// candidate meets question 6 about a passage before ever seeing the passage.
// That bug reached CNPLE's LIVE site and only a real browser found it.
// Truncation is done on a unit boundary too, so a cluster is never cut in half.
function clusterId(q) {
  return q.cluster_id || q.case_id || q.passage_id || null;
}

function pickQuestions(all, limit) {
  const units = [], byId = new Map();
  for (const q of all) {
    const c = clusterId(q);
    if (!c) { units.push([q]); continue; }
    if (!byId.has(c)) { const u = []; byId.set(c, u); units.push(u); }
    byId.get(c).push(q);
  }
  shuffleUnits(units);

  const out = [];
  for (const u of units) {
    if (out.length + u.length > limit) continue;   // never split a cluster
    for (const q of u) out.push(q);
  }
  breakAnswerRuns(out);
  return out;
}

function shuffleUnits(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// Prevent 3+ consecutive same correct answer. Only ever swaps two STANDALONE
// questions: swapping a clustered one would undo the grouping above.
function breakAnswerRuns(arr) {
  const free = i => arr[i] && !clusterId(arr[i]);
  for (let i = 2; i < arr.length; i++) {
    if (correctKey(arr[i]) === correctKey(arr[i-1]) && correctKey(arr[i]) === correctKey(arr[i-2])) {
      if (!free(i)) continue;
      for (let j = i + 1; j < arr.length; j++) {
        if (free(j) && correctKey(arr[j]) !== correctKey(arr[i-1])) {
          [arr[i], arr[j]] = [arr[j], arr[i]];
          break;
        }
      }
    }
  }
}

// ── access gate ───────────────────────────────────────────────────────────────
function setupAccessGate() {
  const attempt = () => {
    const val = document.getElementById("access-code-input").value.trim().toUpperCase();
    if (val === ACCESS_CODE) {
      document.getElementById("access-gate").style.display = "none";
      startExam();
    } else {
      const err = document.getElementById("access-error");
      err.textContent = "Incorrect access code. Please try again.";
      document.getElementById("access-code-input").value = "";
      document.getElementById("access-code-input").focus();
    }
  };
  document.getElementById("access-btn").addEventListener("click", attempt);
  document.getElementById("access-code-input").addEventListener("keydown",
    e => { if (e.key === "Enter") attempt(); });
}

// ── exam start ────────────────────────────────────────────────────────────────
function startExam() {
  if (state.submitted) {
    localStorage.removeItem(STORAGE_KEY);
    state = { phase: "gate", answers: {}, flags: {}, current: 1, timeLeft: EXAM_SECONDS, submitted: false, startTime: null };
  }
  document.getElementById("app").style.display = "flex";
  if (!state.startTime) state.startTime = Date.now();
  renderQuestion();
  startTimer();
  buildGrid();
  document.getElementById("submit-btn").addEventListener("click", confirmSubmit);
  document.getElementById("flag-btn").addEventListener("click",   toggleFlag);
  document.getElementById("prev-btn").addEventListener("click",   () => navigate(-1));
  document.getElementById("next-btn").addEventListener("click",   () => navigate(1));
  document.getElementById("map-btn").addEventListener("click",    openMapModal);
  document.getElementById("map-close").addEventListener("click",  closeMapModal);
  document.getElementById("map-backdrop").addEventListener("click", closeMapModal);
  document.addEventListener("keydown", keyHandler);
}

// ── timer ─────────────────────────────────────────────────────────────────────
function startTimer() {
  updateTimerDisplay();
  timerInterval = setInterval(() => {
    if (state.submitted) return;
    state.timeLeft = Math.max(0, EXAM_SECONDS - Math.floor((Date.now() - state.startTime) / 1000));
    updateTimerDisplay();
    if (state.timeLeft === 0) submitExam();
    saveState();
  }, 1000);
}

function updateTimerDisplay() {
  const h = Math.floor(state.timeLeft / 3600);
  const m = Math.floor((state.timeLeft % 3600) / 60);
  const s = state.timeLeft % 60;
  document.getElementById("timer-display").textContent =
    h > 0 ? `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`
           : `${m}:${String(s).padStart(2,"0")}`;
}

// ── render ─────────────────────────────────────────────────────────────────────
// Any renderer that injects content as HTML must escape it first. This helper
// was missing from the scaffold entirely, so every cluster/passage renderer
// copied in from a finished project threw ReferenceError on its first item.
function escapeHTML(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// A cluster's shared text is shown above EVERY question in that cluster, so a
// candidate never has to page backwards to reread it. It scrolls inside its own
// box: unbounded, a 450 word passage pushes the stem and options below the fold.
function renderCluster(q) {
  const wrap = document.getElementById("q-cluster-wrap");
  if (!wrap) return;
  const text = q.cluster_text || q.case_text || q.passage_text || "";
  if (!text) { wrap.innerHTML = ""; wrap.style.display = "none"; return; }
  const body = String(text).split("\n").filter(l => l.trim())
    .map(l => `<p>${escapeHTML(l.trim())}</p>`).join("");
  wrap.innerHTML = `<div class="cluster-label">${CLUSTER_LABEL} `
                 + `${escapeHTML(clusterId(q) || "")}</div>`
                 + `<div class="cluster-body">${body}</div>`;
  wrap.style.display = "block";
}

function renderQuestion() {
  const q = questions[state.current - 1];
  if (!q) return;
  renderCluster(q);
  document.getElementById("q-counter").textContent = `Question ${state.current} of ${questions.length}`;
  document.getElementById("q-domain").textContent  = domainLabel(q.domain);
  document.getElementById("question-text").textContent = q.question;
  const imgWrap = document.getElementById("q-image-wrap");
  if (q.image) {
    imgWrap.innerHTML = `<img src="${q.image}" alt="" class="q-image">`;
    imgWrap.style.display = "block";
  } else {
    imgWrap.innerHTML = "";
    imgWrap.style.display = "none";
  }
  const fi = document.getElementById("q-flag-indicator");
  fi.style.display = state.flags[state.current] ? "inline-block" : "none";

  document.getElementById("explanation-box").style.display = "none";

  const ol = document.getElementById("options-list");
  ol.innerHTML = "";
  const type = qType(q);
  if (type === "sata") renderSata(q, ol);
  else if (type === "dropdown") renderDropdown(q, ol);
  else if (type === "dragdrop") renderDragdrop(q, ol);
  else if (type === "hotspot_text") renderHotspotText(q, ol);
  else if (type === "cloze") renderCloze(q, ol);
  else if (type === "matrix") renderMatrix(q, ol);
  else if (type === "bowtie") renderBowtie(q, ol);
  else renderMcq(q, ol);

  // Scroll question panel to top on navigation
  const panel = document.querySelector(".question-panel");
  if (panel) panel.scrollTop = 0;

  updateProgress();
  updateGrid();
}

// ── mcq / dropdown (single-selection) ─────────────────────────────────────────
function renderMcq(q, ol) {
  const chosen = state.answers[state.current];
  optionLetters(q).forEach(letter => {
    const text = q.options?.[letter];
    if (!text) return;
    const div = document.createElement("div");
    div.className = "option" + (chosen === letter ? " selected" : "");
    div.innerHTML = `<span class="opt-letter">${letter}</span><span class="opt-text">${escapeHTML(text)}</span>`;
    div.addEventListener("click", () => selectAnswer(state.current, letter));
    ol.appendChild(div);
  });
}

function selectAnswer(qNum, letter) {
  if (state.submitted) return;
  state.answers[qNum] = letter;
  renderQuestion();
  saveState();
}

// ── dropdown (schema-identical to mcq; only the WIDGET differs) ──────────────
// The real NCLEX cloze/drop-down item presents a single <select> instead of a
// click list, but scores exactly like mcq: compare the chosen option letter
// to q.correct.
function renderDropdown(q, ol) {
  const chosen = state.answers[state.current] || "";
  const wrap = document.createElement("div");
  wrap.className = "dropdown-wrap";
  const select = document.createElement("select");
  select.className = "dropdown-select";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Choose...";
  placeholder.disabled = true;
  placeholder.selected = !chosen;
  select.appendChild(placeholder);
  optionLetters(q).forEach(letter => {
    const text = q.options?.[letter];
    if (!text) return;
    const opt = document.createElement("option");
    opt.value = letter;
    opt.textContent = `${letter}. ${text}`;
    if (letter === chosen) opt.selected = true;
    select.appendChild(opt);
  });
  select.addEventListener("change", () => {
    if (select.value) selectAnswer(state.current, select.value);
  });
  wrap.appendChild(select);
  ol.appendChild(wrap);
}

// ── sata (multiple-selection / checklist -- one group of checkboxes) ────────
function renderSata(q, ol) {
  const note = document.createElement("div");
  note.className = "sata-instruction";
  note.textContent = "Select ALL that apply.";
  ol.appendChild(note);
  const chosen = Array.isArray(state.answers[state.current]) ? state.answers[state.current] : [];
  optionLetters(q).forEach(letter => {
    const text = q.options?.[letter];
    if (!text) return;
    const div = document.createElement("div");
    const isChecked = chosen.includes(letter);
    div.className = "option option-checkbox" + (isChecked ? " selected" : "");
    div.innerHTML = `<span class="opt-checkbox">${isChecked ? "☑" : "☐"}</span><span class="opt-letter">${letter}</span><span class="opt-text">${escapeHTML(text)}</span>`;
    div.addEventListener("click", () => toggleSataAnswer(state.current, letter));
    ol.appendChild(div);
  });
}

function toggleSataAnswer(qNum, letter) {
  if (state.submitted) return;
  const current = Array.isArray(state.answers[qNum]) ? state.answers[qNum].slice() : [];
  const idx = current.indexOf(letter);
  if (idx === -1) current.push(letter); else current.splice(idx, 1);
  current.sort();
  if (current.length === 0) {
    delete state.answers[qNum];
  } else {
    state.answers[qNum] = current;
  }
  renderQuestion();
  saveState();
}

// ── hotspot_text (enhanced hot spot -- clickable phrases inside a passage) ──
// q.passage holds the full text with each candidate phrase wrapped in
// [[LETTER|phrase text]] markers. Rendered as plain text interleaved with
// clickable spans for each marked phrase; scores exactly like sata (an exact
// set of letters), so it reuses toggleSataAnswer/isCorrectAnswer's sata path.
function renderHotspotText(q, ol) {
  const note = document.createElement("div");
  note.className = "sata-instruction";
  note.textContent = "Tap the finding(s) below that require immediate follow-up.";
  ol.appendChild(note);
  const chosen = Array.isArray(state.answers[state.current]) ? state.answers[state.current] : [];
  const passageDiv = document.createElement("div");
  passageDiv.className = "hotspot-passage";
  const raw = String(q.passage || "");
  const markerRe = /\[\[([A-Z])\|([^\]]*)\]\]/g;
  let last = 0, m;
  while ((m = markerRe.exec(raw)) !== null) {
    if (m.index > last) {
      passageDiv.appendChild(document.createTextNode(raw.slice(last, m.index)));
    }
    const letter = m[1], text = m[2];
    const span = document.createElement("span");
    const isChecked = chosen.includes(letter);
    span.className = "hotspot-phrase" + (isChecked ? " selected" : "");
    span.textContent = text;
    span.addEventListener("click", () => toggleSataAnswer(state.current, letter));
    passageDiv.appendChild(span);
    last = markerRe.lastIndex;
  }
  if (last < raw.length) {
    passageDiv.appendChild(document.createTextNode(raw.slice(last)));
  }
  ol.appendChild(passageDiv);
}

// ── cloze (multi-blank drop-down within one stem) ────────────────────────────
// q.blanks is an ordered list of mcq-shaped {options} objects. The candidate's
// answer is a POSITIONAL array of letters, one per blank -- distinct from
// sata's unordered set. Rendered as one labeled <select> per blank, since
// this project's stem text is plain (not itself editable HTML), matching how
// the printed book shows "Blank 1: / Blank 2:" beneath the sentence.
function renderCloze(q, ol) {
  const ans = Array.isArray(state.answers[state.current]) ? state.answers[state.current] : [];
  (q.blanks || []).forEach((blank, bi) => {
    const wrap = document.createElement("div");
    wrap.className = "cloze-blank";
    const label = document.createElement("div");
    label.className = "sata-instruction";
    label.textContent = `Blank ${bi + 1}:`;
    wrap.appendChild(label);
    const selWrap = document.createElement("div");
    selWrap.className = "dropdown-wrap";
    const select = document.createElement("select");
    select.className = "dropdown-select";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Choose...";
    placeholder.disabled = true;
    placeholder.selected = !ans[bi];
    select.appendChild(placeholder);
    Object.keys(blank?.options || {}).sort().forEach(letter => {
      const opt = document.createElement("option");
      opt.value = letter;
      opt.textContent = `${letter}. ${blank.options[letter]}`;
      if (ans[bi] === letter) opt.selected = true;
      select.appendChild(opt);
    });
    select.addEventListener("change", () => {
      if (select.value) selectClozeAnswer(state.current, bi, select.value);
    });
    selWrap.appendChild(select);
    wrap.appendChild(selWrap);
    ol.appendChild(wrap);
  });
}

function selectClozeAnswer(qNum, blankIdx, letter) {
  if (state.submitted) return;
  const current = Array.isArray(state.answers[qNum]) ? state.answers[qNum].slice() : [];
  current[blankIdx] = letter;
  state.answers[qNum] = current;
  renderQuestion();
  saveState();
}

// ── matrix (matrix/grid -- one column selection per row) ────────────────────
// q.columns is the fixed list of column labels, q.rows is an ordered list of
// {id, text}. The candidate's answer is a dict {row_id: column_label}.
function renderMatrix(q, ol) {
  const raw = state.answers[state.current];
  const ans = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw : {};
  const cols = q.columns || [];
  const wrap = document.createElement("div");
  wrap.className = "matrix-wrap";
  (q.rows || []).forEach(row => {
    const rowWrap = document.createElement("div");
    rowWrap.className = "matrix-row";
    const label = document.createElement("div");
    label.className = "matrix-row-text";
    label.textContent = row.text;
    rowWrap.appendChild(label);
    const choicesWrap = document.createElement("div");
    choicesWrap.className = "matrix-row-choices";
    cols.forEach(col => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "matrix-choice" + (ans[row.id] === col ? " selected" : "");
      btn.textContent = col;
      btn.addEventListener("click", () => selectMatrixAnswer(state.current, row.id, col));
      choicesWrap.appendChild(btn);
    });
    rowWrap.appendChild(choicesWrap);
    wrap.appendChild(rowWrap);
  });
  ol.appendChild(wrap);
}

function selectMatrixAnswer(qNum, rowId, col) {
  if (state.submitted) return;
  const raw = state.answers[qNum];
  const current = (raw && typeof raw === "object" && !Array.isArray(raw)) ? Object.assign({}, raw) : {};
  current[rowId] = col;
  state.answers[qNum] = current;
  renderQuestion();
  saveState();
}

// ── bowtie (5-part clinical judgment bowtie) ─────────────────────────────────
// q.parts is an ordered list of 5 mcq-shaped {key, label, options} objects.
// The candidate's answer is a dict {part_key: letter}, scored per part.
function renderBowtie(q, ol) {
  const raw = state.answers[state.current];
  const ans = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw : {};
  (q.parts || []).forEach(part => {
    const partWrap = document.createElement("div");
    partWrap.className = "bowtie-part";
    const label = document.createElement("div");
    label.className = "bowtie-part-label";
    label.textContent = part.label || part.key;
    partWrap.appendChild(label);
    const optsWrap = document.createElement("div");
    optsWrap.className = "options-list bowtie-part-options";
    Object.keys(part.options || {}).sort().forEach(letter => {
      const text = part.options[letter];
      const div = document.createElement("div");
      div.className = "option" + (ans[part.key] === letter ? " selected" : "");
      div.innerHTML = `<span class="opt-letter">${letter}</span><span class="opt-text">${escapeHTML(text)}</span>`;
      div.addEventListener("click", () => selectBowtieAnswer(state.current, part.key, letter));
      optsWrap.appendChild(div);
    });
    partWrap.appendChild(optsWrap);
    ol.appendChild(partWrap);
  });
}

function selectBowtieAnswer(qNum, key, letter) {
  if (state.submitted) return;
  const raw = state.answers[qNum];
  const current = (raw && typeof raw === "object" && !Array.isArray(raw)) ? Object.assign({}, raw) : {};
  current[key] = letter;
  state.answers[qNum] = current;
  renderQuestion();
  saveState();
}

// ── dragdrop (ordering exercise) ──────────────────────────────────────────────
// Native HTML5 drag events do not fire on iOS/Android touch, so this uses the
// same tap-to-select-then-tap-to-place family of interaction already used
// elsewhere in this system for touch-safe reordering (see the SE Study Guide
// simulator's drag_and_drop_order type): up/down arrow buttons move a tile,
// no cursor drag required, fully usable on a phone.
//
// q.items is the SCRAMBLED list of elements to arrange (plain strings). Each
// of q.options is one CANDIDATE FULL ORDERING of those same elements written
// out as connected text (e.g. "First, ...; then, ...; finally, ..."), and
// q.correct names the letter of the option matching the true correct order.
// Once the candidate finishes arranging the tiles, ddDeriveLetter() figures
// out which lettered option (if any) that arrangement matches, by finding
// where each item's own text appears inside each option's prose and reading
// off the order those positions imply -- robust to whatever connecting words
// the option uses, since only the substantive item text has to line up.
const dragOrderCache = {}; // qNum -> working order (array of item indices), before first move

function renderDragdrop(q, ol) {
  const ans = state.answers[state.current];
  let order = ans && Array.isArray(ans.order) ? ans.order.slice() : null;
  if (!order) {
    if (!dragOrderCache[state.current]) {
      const ids = (q.items || []).map((_, i) => i);
      shuffleArray(ids);
      dragOrderCache[state.current] = ids;
    }
    order = dragOrderCache[state.current];
  }

  const wrap = document.createElement("div");
  wrap.className = "order-wrap";
  const hint = document.createElement("p");
  hint.className = "pc-hint";
  hint.textContent = "Use the arrows to arrange the items in the best order.";
  wrap.appendChild(hint);

  const list = document.createElement("div");
  list.className = "order-list";
  order.forEach((itemIdx, idx) => {
    const text = (q.items || [])[itemIdx];
    if (text === undefined) return;
    const row = document.createElement("div");
    row.className = "order-row";
    const num = document.createElement("span");
    num.className = "order-num";
    num.textContent = idx + 1;
    const txt = document.createElement("span");
    txt.className = "order-text";
    txt.textContent = text;
    row.appendChild(num);
    row.appendChild(txt);

    const btnWrap = document.createElement("div");
    btnWrap.className = "order-btns";
    const upBtn = document.createElement("button");
    upBtn.type = "button";
    upBtn.className = "order-btn";
    upBtn.textContent = "↑";
    upBtn.setAttribute("aria-label", "Move up");
    upBtn.disabled = idx === 0;
    upBtn.addEventListener("click", () => moveDragdropItem(state.current, order, idx, -1));
    const downBtn = document.createElement("button");
    downBtn.type = "button";
    downBtn.className = "order-btn";
    downBtn.textContent = "↓";
    downBtn.setAttribute("aria-label", "Move down");
    downBtn.disabled = idx === order.length - 1;
    downBtn.addEventListener("click", () => moveDragdropItem(state.current, order, idx, 1));
    btnWrap.appendChild(upBtn);
    btnWrap.appendChild(downBtn);
    row.appendChild(btnWrap);

    list.appendChild(row);
  });
  wrap.appendChild(list);
  ol.appendChild(wrap);
}

function moveDragdropItem(qNum, currentOrder, idx, dir) {
  if (state.submitted) return;
  const newOrder = currentOrder.slice();
  const target = idx + dir;
  if (target < 0 || target >= newOrder.length) return;
  [newOrder[idx], newOrder[target]] = [newOrder[target], newOrder[idx]];
  delete dragOrderCache[qNum];
  state.answers[qNum] = { order: newOrder };
  renderQuestion();
  saveState();
}

// Given the candidate's current arrangement (an array of 0-based indices into
// q.items), find which lettered option's prose implies that same order of
// items, by the position each item's text appears at inside the option.
// Returns null if no option's implied order matches (e.g. arrangement not
// finished, or none of the 4 candidate orderings match what was built).
function ddDeriveLetter(q, order) {
  if (!Array.isArray(order) || !q.items || !q.options) return null;
  for (const letter of Object.keys(q.options)) {
    const optText = String(q.options[letter] || "").toLowerCase();
    const positions = q.items.map((text, idx) => {
      const p = optText.indexOf(String(text).toLowerCase());
      return { idx, p: p === -1 ? Infinity : p };
    });
    if (positions.some(p => p.p === Infinity)) continue; // an item's text isn't in this option at all
    positions.sort((a, b) => a.p - b.p);
    const optOrder = positions.map(p => p.idx);
    if (optOrder.length === order.length && optOrder.every((v, i) => v === order[i])) {
      return letter;
    }
  }
  return null;
}

// ── answered / scoring (shared across all item types) ────────────────────────
function isAnswered(qNum) {
  const q = questions[qNum - 1];
  const ans = state.answers[qNum];
  if (!q) return false;
  const type = qType(q);
  if (type === "sata" || type === "hotspot_text") return Array.isArray(ans) && ans.length > 0;
  if (type === "dragdrop") return !!(ans && Array.isArray(ans.order));
  if (type === "cloze") {
    const n = (q.blanks || []).length;
    return Array.isArray(ans) && ans.length === n && ans.every(v => !!v);
  }
  if (type === "matrix") {
    const n = (q.rows || []).length;
    return !!ans && typeof ans === "object" && !Array.isArray(ans) && Object.keys(ans).length === n;
  }
  if (type === "bowtie") {
    const n = (q.parts || []).length;
    return !!ans && typeof ans === "object" && !Array.isArray(ans) && Object.keys(ans).length === n;
  }
  return ans !== undefined && ans !== null && ans !== "";
}

function answeredCount() {
  let n = 0;
  for (let i = 1; i <= questions.length; i++) if (isAnswered(i)) n++;
  return n;
}

// A SATA/hotspot_text answer is correct only if the candidate's selected set
// is EXACTLY the keyed set -- no partial credit. A dragdrop answer is correct
// only if the arranged order resolves (via ddDeriveLetter) to the keyed
// letter. A cloze answer is correct only if EVERY blank's letter matches its
// keyed letter at that same position. A matrix answer is correct only if
// EVERY row matches its keyed column. A bowtie answer is correct only if
// EVERY part matches its keyed letter (see bowtiePartsCorrectCount for the
// partial per-part breakdown shown during review).
function isCorrectAnswer(q, ans) {
  const type = qType(q);
  if (type === "sata" || type === "hotspot_text") {
    if (!Array.isArray(ans) || !Array.isArray(q.correct)) return false;
    if (ans.length !== q.correct.length) return false;
    const a = ans.slice().sort(), b = q.correct.slice().sort();
    return a.every((v, i) => v === b[i]);
  }
  if (type === "dragdrop") {
    if (!ans || !Array.isArray(ans.order)) return false;
    return ddDeriveLetter(q, ans.order) === q.correct;
  }
  if (type === "cloze") {
    if (!Array.isArray(ans) || !Array.isArray(q.correct)) return false;
    if (ans.length !== q.correct.length) return false;
    return ans.every((v, i) => v === q.correct[i]);
  }
  if (type === "matrix") {
    if (!ans || typeof ans !== "object" || !q.correct) return false;
    const keys = Object.keys(q.correct);
    return keys.length > 0 && keys.every(k => ans[k] === q.correct[k]);
  }
  if (type === "bowtie") {
    if (!ans || typeof ans !== "object" || !q.correct) return false;
    const keys = Object.keys(q.correct);
    return keys.length > 0 && keys.every(k => ans[k] === q.correct[k]);
  }
  return ans === q.correct; // mcq, dropdown
}

// How many of a bowtie's 5 parts the candidate got right, for the partial
// per-part feedback shown during review (the aggregate score above still
// requires all 5 for the question to count as "correct").
function bowtiePartsCorrectCount(q, ans) {
  if (!ans || typeof ans !== "object" || !q.correct) return 0;
  return Object.keys(q.correct).filter(k => ans[k] === q.correct[k]).length;
}

function navigate(dir) {
  const next = state.current + dir;
  if (next >= 1 && next <= questions.length) {
    state.current = next;
    renderQuestion();
  }
}

function toggleFlag() {
  state.flags[state.current] = !state.flags[state.current];
  renderQuestion();
  saveState();
}

function updateProgress() {
  const pct = answeredCount() / questions.length * 100;
  document.getElementById("progress-bar").style.width = pct + "%";
}

// ── question map modal ────────────────────────────────────────────────────────
function openMapModal() {
  updateGrid();
  document.getElementById("map-modal").style.display = "flex";
}

function closeMapModal() {
  document.getElementById("map-modal").style.display = "none";
}

// ── grid ──────────────────────────────────────────────────────────────────────
function buildGrid() {
  const grid = document.getElementById("q-grid");
  grid.innerHTML = "";
  for (let i = 1; i <= questions.length; i++) {
    const btn = document.createElement("button");
    btn.className = "grid-btn";
    btn.id = `gb-${i}`;
    btn.textContent = i;
    btn.addEventListener("click", () => {
      state.current = i;
      closeMapModal();
      renderQuestion();
    });
    grid.appendChild(btn);
  }
}

function updateGrid() {
  for (let i = 1; i <= questions.length; i++) {
    const btn = document.getElementById(`gb-${i}`);
    if (!btn) continue;
    btn.className = "grid-btn" +
      (isAnswered(i)     ? " answered" : "") +
      (state.flags[i]    ? " flagged"  : "") +
      (state.current===i ? " active"   : "");
  }
}

// ── submit ────────────────────────────────────────────────────────────────────
function confirmSubmit() {
  const unanswered = questions.length - answeredCount();
  if (unanswered > 0) {
    alert(`You must answer all ${questions.length} questions before submitting.\n\n${unanswered} question${unanswered > 1 ? "s" : ""} still unanswered.\n\nTap "Question Map" to find unanswered questions.`);
    return;
  }
  if (confirm("Submit your exam now?")) submitExam();
}

function submitExam() {
  clearInterval(timerInterval);
  state.submitted = true;
  saveState();
  showResults();
}

// ── results ───────────────────────────────────────────────────────────────────
function showResults() {
  document.getElementById("app").style.display = "none";
  document.getElementById("results-screen").style.display = "flex";

  let correct = 0;
  const domainStats = {};
  questions.forEach((q, idx) => {
    const num = idx + 1;
    const userAns = state.answers[num];
    const isRight = isCorrectAnswer(q, userAns);
    if (isRight) correct++;
    const dom = q.domain || "Other";
    if (!domainStats[dom]) domainStats[dom] = { correct: 0, total: 0 };
    domainStats[dom].total++;
    if (isRight) domainStats[dom].correct++;
  });

  const pct  = Math.round(correct / questions.length * 100);
  const passed = pct >= PASSING_PCT;
  document.getElementById("res-status").textContent = passed ? "PASS" : "FAIL";
  document.getElementById("res-status").style.color = passed ? "#059669" : "#DC2626";
  document.getElementById("res-score").textContent  = `${correct} / ${questions.length} (${pct}%)`;

  const domDiv = document.getElementById("res-domains");
  domDiv.innerHTML = "";
  Object.entries(domainStats).forEach(([dom, s]) => {
    const dp = Math.round(s.correct / s.total * 100);
    domDiv.innerHTML += `<div class="res-domain-row">
      <span class="res-domain-name">${domainLabel(dom)}</span>
      <div class="res-domain-bar-wrap"><div class="res-domain-bar" style="width:${dp}%;background:#1B3A6B"></div></div>
      <span class="res-domain-pct">${dp}%</span>
    </div>`;
  });

  document.getElementById("res-review-btn").addEventListener("click", () => {
    state.submitted = true;
    document.getElementById("results-screen").style.display = "none";
    document.getElementById("app").style.display = "flex";
    renderReview();
  });
  document.getElementById("res-restart-btn").addEventListener("click", () => {
    localStorage.removeItem(STORAGE_KEY);
    location.reload();
  });
}

function renderReview() {
  const ol = document.getElementById("options-list");
  const q  = questions[state.current - 1];
  if (!q) return;
  document.getElementById("q-counter").textContent = `Review, Question ${state.current} of ${questions.length}`;
  document.getElementById("question-text").textContent = q.question;
  const revImgWrap = document.getElementById("q-image-wrap");
  if (q.image) {
    revImgWrap.innerHTML = `<img src="${q.image}" alt="" class="q-image">`;
    revImgWrap.style.display = "block";
  } else {
    revImgWrap.innerHTML = "";
    revImgWrap.style.display = "none";
  }
  ol.innerHTML = "";
  const userAns = state.answers[state.current];
  const type = qType(q);

  if (type === "sata" || type === "hotspot_text") {
    const correctSet = Array.isArray(q.correct) ? q.correct : [];
    const userSet = Array.isArray(userAns) ? userAns : [];
    optionLetters(q).forEach(letter => {
      const text = q.options?.[letter];
      if (!text) return;
      const div = document.createElement("div");
      let cls = "option option-checkbox";
      const wasSelected = userSet.includes(letter);
      const isCorrectLetter = correctSet.includes(letter);
      if (isCorrectLetter && wasSelected)      cls += " correct";
      else if (isCorrectLetter && !wasSelected) cls += " missed";     // correct but user didn't pick it
      else if (!isCorrectLetter && wasSelected) cls += " incorrect";  // picked but shouldn't have
      div.className = cls;
      const mark = wasSelected ? "☑" : "☐";
      div.innerHTML = `<span class="opt-checkbox">${mark}</span><span class="opt-letter">${letter}</span><span class="opt-text">${escapeHTML(text)}</span>`;
      ol.appendChild(div);
    });
  } else if (type === "cloze") {
    const correctArr = Array.isArray(q.correct) ? q.correct : [];
    const userArr = Array.isArray(userAns) ? userAns : [];
    (q.blanks || []).forEach((blank, bi) => {
      const wrap = document.createElement("div");
      wrap.className = "cloze-blank";
      const label = document.createElement("div");
      label.className = "sata-instruction";
      label.textContent = `Blank ${bi + 1}:`;
      wrap.appendChild(label);
      Object.keys(blank?.options || {}).sort().forEach(letter => {
        const text = blank.options[letter];
        const div = document.createElement("div");
        let cls = "option";
        if (letter === correctArr[bi])          cls += " correct";
        else if (letter === userArr[bi])         cls += " incorrect";
        div.className = cls;
        div.innerHTML = `<span class="opt-letter">${letter}</span><span class="opt-text">${escapeHTML(text)}</span>`;
        wrap.appendChild(div);
      });
      ol.appendChild(wrap);
    });
  } else if (type === "matrix") {
    const correctDict = (q.correct && typeof q.correct === "object") ? q.correct : {};
    const userDict = (userAns && typeof userAns === "object" && !Array.isArray(userAns)) ? userAns : {};
    const cols = q.columns || [];
    (q.rows || []).forEach(row => {
      const rowWrap = document.createElement("div");
      rowWrap.className = "matrix-row";
      const label = document.createElement("div");
      label.className = "matrix-row-text";
      label.textContent = row.text;
      rowWrap.appendChild(label);
      const choicesWrap = document.createElement("div");
      choicesWrap.className = "matrix-row-choices";
      cols.forEach(col => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.disabled = true;
        let cls = "matrix-choice";
        const wasChosen = userDict[row.id] === col;
        const isRightCol = correctDict[row.id] === col;
        if (isRightCol)                 cls += " correct";
        else if (wasChosen && !isRightCol) cls += " incorrect";
        btn.className = cls;
        btn.textContent = col;
        choicesWrap.appendChild(btn);
      });
      rowWrap.appendChild(choicesWrap);
      ol.appendChild(rowWrap);
    });
  } else if (type === "bowtie") {
    const correctDict = (q.correct && typeof q.correct === "object") ? q.correct : {};
    const userDict = (userAns && typeof userAns === "object" && !Array.isArray(userAns)) ? userAns : {};
    const score = bowtiePartsCorrectCount(q, userDict);
    const scoreNote = document.createElement("p");
    scoreNote.className = "pc-hint";
    scoreNote.textContent = `${score} of ${(q.parts || []).length} parts correct.`;
    ol.appendChild(scoreNote);
    (q.parts || []).forEach(part => {
      const partWrap = document.createElement("div");
      partWrap.className = "bowtie-part";
      const label = document.createElement("div");
      label.className = "bowtie-part-label";
      label.textContent = part.label || part.key;
      partWrap.appendChild(label);
      const optsWrap = document.createElement("div");
      optsWrap.className = "options-list bowtie-part-options";
      Object.keys(part.options || {}).sort().forEach(letter => {
        const text = part.options[letter];
        const div = document.createElement("div");
        let cls = "option";
        if (letter === correctDict[part.key])           cls += " correct";
        else if (letter === userDict[part.key])          cls += " incorrect";
        div.className = cls;
        div.innerHTML = `<span class="opt-letter">${letter}</span><span class="opt-text">${escapeHTML(text)}</span>`;
        optsWrap.appendChild(div);
      });
      partWrap.appendChild(optsWrap);
      ol.appendChild(partWrap);
    });
  } else {
    // mcq, dropdown, and dragdrop all review the same way: the lettered
    // candidate answers, with the keyed letter highlighted green and whatever
    // the candidate effectively chose (their picked letter for mcq/dropdown,
    // or the letter their tile arrangement resolves to for dragdrop)
    // highlighted red if it was wrong.
    const selectedLetter = type === "dragdrop"
      ? (userAns && Array.isArray(userAns.order) ? ddDeriveLetter(q, userAns.order) : null)
      : (typeof userAns === "string" ? userAns : null);
    optionLetters(q).forEach(letter => {
      const text = q.options?.[letter];
      if (!text) return;
      const div = document.createElement("div");
      let cls = "option";
      if (letter === q.correct)            cls += " correct";
      else if (letter === selectedLetter)  cls += " incorrect";
      div.className = cls;
      div.innerHTML = `<span class="opt-letter">${letter}</span><span class="opt-text">${escapeHTML(text)}</span>`;
      ol.appendChild(div);
    });
    if (type === "dragdrop" && !selectedLetter) {
      const note = document.createElement("p");
      note.className = "pc-hint";
      note.textContent = "Your arrangement did not match any of the orderings shown above.";
      ol.appendChild(note);
    }
  }

  const box  = document.getElementById("explanation-box");
  const expl = document.getElementById("explanation-text");
  if (q.explanation) {
    expl.textContent = q.explanation;
    box.style.display = "block";
  } else {
    box.style.display = "none";
  }

  document.getElementById("prev-btn").onclick = () => { navigate(-1); renderReview(); };
  document.getElementById("next-btn").onclick = () => { navigate(1);  renderReview(); };
}

// ── persistence ───────────────────────────────────────────────────────────────
function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch(e) {}
}
function restoreState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) { const s = JSON.parse(saved); Object.assign(state, s); }
  } catch(e) {}
}

// ── keyboard ──────────────────────────────────────────────────────────────────
const SATA_LETTERS = ["A", "B", "C", "D", "E", "F", "G"];

function keyHandler(e) {
  const q = questions[state.current - 1];
  const type = q ? qType(q) : "mcq";
  if (!e.ctrlKey && !e.metaKey) {
    if (type === "sata" || type === "hotspot_text") {
      // Number-row 1-7 or letter keys A-G both toggle the corresponding checkbox.
      let letter = null;
      if (/^[1-7]$/.test(e.key)) letter = SATA_LETTERS[parseInt(e.key, 10) - 1];
      else if (SATA_LETTERS.includes(e.key.toUpperCase())) letter = e.key.toUpperCase();
      if (letter && q?.options?.[letter]) toggleSataAnswer(state.current, letter);
    } else if (type === "dragdrop" || type === "cloze" || type === "matrix" || type === "bowtie") {
      // No single-letter shortcuts for these: dragdrop arranges via the
      // up/down buttons, cloze/matrix/bowtie each hold MULTIPLE independent
      // choices in one question, so a bare letter or number key is ambiguous
      // about which blank/row/part it should apply to. Arrow keys below stay
      // reserved for moving between questions.
    } else {
      // mcq and dropdown both key a single letter the same way.
      const letter = e.key.toUpperCase();
      if (["A", "B", "C", "D", "E"].includes(letter) && q?.options?.[letter]) {
        selectAnswer(state.current, letter);
      }
    }
  }
  if (e.key === "ArrowRight" && state.current < questions.length) navigate(1);
  if (e.key === "ArrowLeft"  && state.current > 1)                navigate(-1);
  if (e.key === "Escape") closeMapModal();
}
