import {
  configured,
  auth,
  db,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  GoogleAuthProvider,
  doc,
  collection,
  getDocs,
  setDoc,
  updateDoc,
  writeBatch,
  onSnapshot,
  serverTimestamp,
  increment,
  query,
  where,
  limit,
} from "./firebase.js";

const $ = (id) => document.getElementById(id);

// Join codes skip 0/O, 1/I/L so they read cleanly off a projector.
const CODE_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 5;

// While results are hidden the page renders this instead of real data, so the
// blur can't leak the shape of the distribution.
const PLACEHOLDER = [1, 2, 3, 5, 7, 8, 7, 5, 3, 2, 1].flatMap((count, v) => Array(count).fill(v));

let sessionRef = null;
let joinUrl = "";
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
    await updateDoc(sessionRef, { ...fields, updated: serverTimestamp() });
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

// Round 1 must start empty, or phones would reload last session's votes, so
// reset deletes every round's votes. Voting closes first so nothing lands mid-delete.
async function resetRounds() {
  if (busy || round === null) return;
  const last = round;
  if (!confirm(`Reset to round 1? This permanently deletes the votes from all ${last} rounds.`)) return;
  busy = true;
  say("Resetting…");
  try {
    await updateDoc(sessionRef, { open: false, updated: serverTimestamp() });
    const snaps = await Promise.all(
      Array.from({ length: last }, (_, i) => getDocs(votesRef(i + 1))),
    );
    const refs = snaps.flatMap((s) => s.docs.map((d) => d.ref));
    for (let i = 0; i < refs.length; i += 500) {
      const batch = writeBatch(db); // 500 writes per batch max
      refs.slice(i, i + 500).forEach((ref) => batch.delete(ref));
      await batch.commit();
    }
    await updateDoc(sessionRef, { round: 1, open: true, updated: serverTimestamp() });
    say(`Reset to round 1, deleted ${refs.length} votes`);
  } catch (err) {
    say(`Reset failed: ${err.code ?? err.message}`, true);
  } finally {
    busy = false;
  }
}

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
        const s = stats(voteValues((await getDocs(votesRef(r))).docs));
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
const votesRef = (r) => collection(sessionRef, "rounds", String(r), "votes");

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes, (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
}

// Each Google account gets one session, reused across visits. A code someone
// else already owns fails the rules (it would be an update), so pick another.
async function findOrCreateSession(uid) {
  const mine = await getDocs(query(collection(db, "sessions"), where("host", "==", uid), limit(1)));
  if (!mine.empty) return mine.docs[0].ref;
  for (let tries = 0; tries < 5; tries++) {
    const ref = doc(db, "sessions", randomCode());
    try {
      await setDoc(ref, { host: uid, round: 1, open: true, updated: serverTimestamp() });
      return ref;
    } catch (err) {
      if (err.code !== "permission-denied") throw err;
    }
  }
  throw new Error("no free join code");
}

function subscribeVotes(r) {
  unsubVotes?.();
  votes = [];
  unsubVotes = onSnapshot(
    votesRef(r),
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
    text: joinUrl,
    width: size,
    height: size,
    colorDark: "#000000",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.M,
  });
  el.title = ""; // qrcodejs sets the URL as a tooltip
}

async function start(user) {
  if (started) return;
  started = true;
  showGate({ title: "Loading…" });
  try {
    sessionRef = await findOrCreateSession(user.uid);
  } catch (err) {
    started = false;
    showGate({ title: "Couldn't start a session", text: err.code ?? err.message, signedIn: true });
    return;
  }
  $("gate").hidden = true;
  $("host").hidden = false;

  const url = new URL("./", location.href);
  url.searchParams.set("s", sessionRef.id);
  joinUrl = url.href;
  const joinText = joinUrl.replace(/^https?:\/\//, "");
  $("join-url").textContent = joinText;
  $("overlay-url").textContent = joinText;
  makeQr($("qr-small"), 192);
  makeQr($("qr-big"), 640);
  buildHistogram();
  render();

  onSnapshot(
    sessionRef,
    (snap) => {
      if (!snap.exists()) {
        say("Session was deleted — reload to start a new one", true);
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

function showGate({ title, text = "", signIn = false, signedIn = false }) {
  $("gate").hidden = false;
  $("host").hidden = true;
  $("gate-title").textContent = title;
  $("gate-text").textContent = text;
  $("sign-in").hidden = !signIn;
  $("gate-sign-out").hidden = !signedIn;
}

$("next").addEventListener("click", () => nextRound(false));
$("toggle-open").addEventListener("click", toggleOpen);
$("toggle-results").addEventListener("click", toggleResults);
$("show-qr").addEventListener("click", () => toggleQr(true));
$("reset").addEventListener("click", resetRounds);
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
    if (!user || user.isAnonymous) showGate({ title: "Host", text: "Sign in to run a poll.", signIn: true });
    else start(user);
  });
}
