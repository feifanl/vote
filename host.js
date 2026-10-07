import {
  configured,
  auth,
  db,
  HOST_UID,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  GoogleAuthProvider,
  doc,
  collection,
  getDocs,
  setDoc,
  updateDoc,
  onSnapshot,
  serverTimestamp,
  increment,
} from "./firebase.js";

const $ = (id) => document.getElementById(id);

const JOIN_URL = new URL("./", location.href).href;
const JOIN_TEXT = JOIN_URL.replace(/^https?:\/\//, "").replace(/\/$/, "");

// While results are hidden the page renders this instead of real data, so the
// blur can't leak the shape of the distribution.
const PLACEHOLDER = [1, 2, 3, 5, 7, 8, 7, 5, 3, 2, 1].flatMap((count, v) => Array(count).fill(v));

const stateRef = configured && doc(db, "state", "current");

let started = false;
let round = null;
let open = false;
let hidden = true;
let votes = [];
let unsubVotes = null;
let busy = false;
let msgTimer = 0;

/* ---------------------------------------------------------------- */
/*  Stats                                                            */
/* ---------------------------------------------------------------- */
function stats(values) {
  const n = values.length;
  const counts = Array(11).fill(0);
  for (const v of values) counts[Math.round(v)]++; // one bar per whole number
  if (!n) return { n, counts, mean: null, median: null, sd: null };

  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const mid = n >> 1;
  const median = n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  // Population SD: describes the room, not a sample estimate.
  const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
  return { n, counts, mean, median, sd };
}

const voteValues = (docs) =>
  docs.map((d) => d.data().value).filter((v) => typeof v === "number" && v >= 0 && v <= 10);

const fmt = (x) => (x === null ? "—" : x.toFixed(1));

/* ---------------------------------------------------------------- */
/*  Render                                                           */
/* ---------------------------------------------------------------- */
const bars = [];

function buildHistogram() {
  for (let v = 0; v <= 10; v++) {
    const col = document.createElement("div");
    col.className = "hist__col";
    const count = document.createElement("div");
    count.className = "hist__count num";
    const bar = document.createElement("div");
    bar.className = "hist__bar";
    col.append(count, bar);
    $("bars").append(col);
    bars.push({ count, bar });

    const tick = document.createElement("span");
    tick.textContent = v;
    $("axis").append(tick);
  }
}

function render() {
  $("round").textContent = round === null ? " " : `Round ${round}`;
  $("badge").textContent = open ? "Open" : "Closed";
  $("badge").classList.toggle("is-open", open);
  $("toggle-open").lastElementChild.textContent = open ? "Close voting" : "Open voting";
  $("toggle-results").lastElementChild.textContent = hidden ? "Show results" : "Hide results";
  $("board").classList.toggle("is-hidden", hidden);

  const real = stats(votes);
  const shown = hidden ? stats(PLACEHOLDER) : real;
  $("n").textContent = real.n;
  $("avg").textContent = fmt(shown.mean);
  $("median").textContent = fmt(shown.median);
  $("sd").textContent = fmt(shown.sd);

  const max = Math.max(...shown.counts);
  shown.counts.forEach((c, v) => {
    bars[v].count.textContent = c;
    bars[v].count.classList.toggle("is-zero", c === 0);
    bars[v].bar.style.setProperty("--f", max ? c / max : 0);
  });
}

function say(text, isError = false) {
  $("msg").textContent = text;
  $("msg").style.color = isError ? "var(--danger)" : "";
  clearTimeout(msgTimer);
  if (text) msgTimer = setTimeout(() => say(""), 5000);
}

/* ---------------------------------------------------------------- */
/*  Actions                                                          */
/* ---------------------------------------------------------------- */
async function write(fields) {
  if (busy || round === null) return;
  busy = true;
  try {
    await updateDoc(stateRef, { ...fields, updated: serverTimestamp() });
  } catch (err) {
    say(`Couldn't update: ${err.code ?? err.message}`, true);
  } finally {
    busy = false;
  }
}

function nextRound(fromKeyboard) {
  if (round === null) return;
  if (!fromKeyboard && votes.length && !confirm(`Start round ${round + 1}? Round ${round} has ${votes.length} votes.`)) {
    return;
  }
  write({ round: increment(1), open: true });
}

const toggleOpen = () => write({ open: !open });

function toggleResults() {
  hidden = !hidden;
  render();
}

function toggleQr(show = $("overlay").hidden) {
  $("overlay").hidden = !show;
}

async function loadPast() {
  const $rows = $("past-rows");
  if (round === null || round <= 1) {
    $rows.innerHTML = `<tr><td colspan="3">No past rounds yet</td></tr>`;
    return;
  }
  const rounds = Array.from({ length: round - 1 }, (_, i) => round - 1 - i);
  try {
    const rows = await Promise.all(
      rounds.map(async (r) => {
        const s = stats(voteValues((await getDocs(collection(db, "rounds", String(r), "votes"))).docs));
        return `<tr><td>${r}</td><td>${s.n}</td><td>${fmt(s.mean)}</td></tr>`;
      }),
    );
    $rows.innerHTML = rows.join("");
  } catch (err) {
    $rows.innerHTML = `<tr><td colspan="3">Couldn't load: ${err.code ?? err.message}</td></tr>`;
  }
}

/* ---------------------------------------------------------------- */
/*  Wiring                                                           */
/* ---------------------------------------------------------------- */
function subscribeVotes(r) {
  unsubVotes?.();
  votes = [];
  unsubVotes = onSnapshot(
    collection(db, "rounds", String(r), "votes"),
    (snap) => {
      votes = voteValues(snap.docs);
      render();
    },
    (err) => say(`Lost vote feed: ${err.code ?? err.message}`, true),
  );
}

function makeQr(el, size) {
  if (!window.QRCode) {
    el.hidden = true;
    return;
  }
  new QRCode(el, {
    text: JOIN_URL,
    width: size,
    height: size,
    colorDark: "#000000",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.M,
  });
  el.title = ""; // qrcodejs sets the URL as a tooltip
}

function start() {
  if (started) return;
  started = true;
  $("gate").hidden = true;
  $("host").hidden = false;

  $("join-url").textContent = JOIN_TEXT;
  $("overlay-url").textContent = JOIN_TEXT;
  makeQr($("qr-small"), 192);
  makeQr($("qr-big"), 640);
  buildHistogram();
  render();

  onSnapshot(
    stateRef,
    (snap) => {
      if (!snap.exists()) {
        setDoc(stateRef, { round: 1, open: true, updated: serverTimestamp() }).catch((err) =>
          say(`Couldn't create state: ${err.code ?? err.message}`, true),
        );
        return;
      }
      const data = snap.data();
      open = data.open === true;
      if (data.round !== round) {
        round = data.round;
        hidden = true;
        subscribeVotes(round);
        if ($("past").open) loadPast();
      }
      render();
    },
    (err) => say(`Lost connection: ${err.code ?? err.message}`, true),
  );
}

function showGate({ title, text = "", uid = null, signIn = false }) {
  $("gate-title").textContent = title;
  $("gate-text").textContent = text;
  $("account").hidden = !uid;
  $("uid").textContent = uid ?? "";
  $("sign-in").hidden = !signIn;
  $("gate-sign-out").hidden = signIn || !uid;
}

$("next").addEventListener("click", () => nextRound(false));
$("toggle-open").addEventListener("click", toggleOpen);
$("toggle-results").addEventListener("click", toggleResults);
$("show-qr").addEventListener("click", () => toggleQr(true));
$("join").addEventListener("click", () => toggleQr(true));
$("overlay").addEventListener("click", () => toggleQr(false));
$("past").addEventListener("toggle", () => $("past").open && loadPast());

document.addEventListener("keydown", (e) => {
  if (!started || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  const actions = {
    n: () => nextRound(true),
    c: toggleOpen,
    h: toggleResults,
    q: () => toggleQr(),
    escape: () => toggleQr(false),
  };
  const action = actions[e.key.toLowerCase()];
  if (!action) return;
  e.preventDefault();
  action();
});

if (!configured) {
  showGate({ title: "Not configured", text: "Fill in config.js — see README." });
} else {
  const provider = new GoogleAuthProvider();
  const doSignOut = () => signOut(auth).then(() => location.reload());
  $("sign-in").addEventListener("click", () =>
    signInWithPopup(auth, provider).catch((err) => {
      if (err.code !== "auth/popup-closed-by-user") $("gate-text").textContent = `Sign-in failed: ${err.code}`;
    }),
  );
  $("gate-sign-out").addEventListener("click", doSignOut);
  $("sign-out").addEventListener("click", doSignOut);

  showGate({ title: " " });
  onAuthStateChanged(auth, (user) => {
    // An anonymous voter session from index.html on this browser counts as signed out here.
    if (!user || user.isAnonymous) showGate({ title: "Host", text: "Sign in to run the poll.", signIn: true });
    else if (user.uid !== HOST_UID) showGate({ title: "Not authorized", uid: user.uid });
    else start();
  });
}
