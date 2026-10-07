import {
  configured,
  auth,
  db,
  onAuthStateChanged,
  signInAnonymously,
  doc,
  getDoc,
  setDoc,
  onSnapshot,
  serverTimestamp,
} from "./firebase.js";

const MAX = 10;
const snap = (v) => Math.round(Math.min(MAX, Math.max(0, v)) * 10) / 10; // 0.1 steps
const OFFLINE_MSG = "Offline — your vote will save when you reconnect";

const $round = document.getElementById("round");
const $value = document.getElementById("value");
const $slider = document.getElementById("slider");
const $status = document.getElementById("status");

let uid = null;
let round = null; // null until state/current exists
let open = false;
let value = null; // null = untouched this round
let saved = null; // last value the server acknowledged this round
let saveSeq = 0;
let pendingSeq = 0; // nonzero while a write is unacknowledged
let pendingTimer = 0;
let keyTimer = 0;
let dragging = false;

const canVote = () => uid !== null && round !== null && open;

function setStatus(text, tone) {
  $status.textContent = text;
  if (tone) $status.dataset.tone = tone;
  else delete $status.dataset.tone;
}

function idleStatus() {
  if (round === null) return "Waiting for host…";
  if (!open) return "Voting closed";
  if (value === null) return "Slide to vote";
  return value === saved ? "Saved" : "";
}

function render() {
  const unset = value === null;
  $value.textContent = unset ? "–" : value.toFixed(1);
  $value.classList.toggle("is-unset", unset);
  $slider.classList.toggle("is-unset", unset);
  $slider.style.setProperty("--pct", unset ? "0%" : `${(value / MAX) * 100}%`);
  if (unset) $slider.removeAttribute("aria-valuenow");
  else $slider.setAttribute("aria-valuenow", String(value));
  $slider.setAttribute("aria-disabled", String(!canVote()));
}

function pick(v) {
  if (v === value) return;
  value = v;
  render();
  if (!pendingSeq) setStatus(idleStatus());
}

async function commit() {
  if (!canVote() || value === null || value === saved) {
    if (!pendingSeq) setStatus(idleStatus());
    return;
  }
  const seq = ++saveSeq;
  const v = value;
  const r = round;
  pendingSeq = seq;
  setStatus("Saving…");
  clearTimeout(pendingTimer);
  // Firestore queues writes while offline instead of failing, so surface the wait.
  pendingTimer = setTimeout(
    () => seq === pendingSeq && setStatus(OFFLINE_MSG, "warn"),
    navigator.onLine ? 4000 : 0,
  );

  try {
    await setDoc(doc(db, "rounds", String(r), "votes", uid), { value: v, ts: serverTimestamp() });
    if (r !== round) return;
    saved = v; // writes to one doc are acknowledged in order
    if (seq !== pendingSeq) return;
    pendingSeq = 0;
    clearTimeout(pendingTimer);
    setStatus(idleStatus());
  } catch {
    if (r !== round || seq !== pendingSeq) return;
    pendingSeq = 0;
    clearTimeout(pendingTimer);
    setStatus(open ? "Couldn't save — move the slider to retry" : "Voting closed — not saved", "error");
  }
}

function valueAt(clientX) {
  const box = $slider.getBoundingClientRect();
  return snap(((clientX - box.left) / box.width) * MAX);
}

function endDrag() {
  dragging = false;
  $slider.classList.remove("is-dragging");
}

$slider.addEventListener("pointerdown", (e) => {
  if (!canVote() || e.button !== 0) return;
  dragging = true;
  $slider.setPointerCapture(e.pointerId);
  $slider.classList.add("is-dragging");
  pick(valueAt(e.clientX));
});

$slider.addEventListener("pointermove", (e) => {
  if (dragging) pick(valueAt(e.clientX));
});

$slider.addEventListener("pointerup", () => {
  if (!dragging) return;
  endDrag();
  commit();
});

$slider.addEventListener("pointercancel", () => {
  if (!dragging) return;
  endDrag();
  commit();
});

const KEY_STEPS = { ArrowLeft: -0.1, ArrowDown: -0.1, ArrowRight: 0.1, ArrowUp: 0.1, PageDown: -1, PageUp: 1 };

$slider.addEventListener("keydown", (e) => {
  if (!canVote()) return;
  let next;
  if (e.key === "Home") next = 0;
  else if (e.key === "End") next = MAX;
  else if (e.key in KEY_STEPS) next = (value ?? MAX / 2) + (value === null ? 0 : KEY_STEPS[e.key]);
  else return;
  e.preventDefault();
  pick(snap(next));
  clearTimeout(keyTimer);
  keyTimer = setTimeout(commit, 600);
});

window.addEventListener("offline", () => setStatus(pendingSeq ? OFFLINE_MSG : "You're offline", "warn"));
window.addEventListener("online", () => setStatus(pendingSeq ? "Saving…" : idleStatus()));

function flashRound() {
  $round.classList.remove("is-new");
  void $round.offsetWidth; // restart the animation
  $round.classList.add("is-new");
  setTimeout(() => $round.classList.remove("is-new"), 2000);
}

async function loadMine(r) {
  try {
    const snap = await getDoc(doc(db, "rounds", String(r), "votes", uid));
    if (r !== round || value !== null || !snap.exists()) return;
    value = saved = snap.data().value;
    render();
    if (!pendingSeq) setStatus(idleStatus());
  } catch {
    // Nothing to restore; the slider stays unset.
  }
}

function listen() {
  onSnapshot(
    doc(db, "state", "current"),
    (snap) => {
      const data = snap.exists() ? snap.data() : null;
      const prev = round;
      open = data?.open === true;
      const next = data ? data.round : null;

      if (next !== prev) {
        round = next;
        value = saved = null;
        pendingSeq = 0;
        clearTimeout(pendingTimer);
        clearTimeout(keyTimer);
        endDrag();
        $round.textContent = round === null ? " " : `Round ${round}`;
        if (round !== null) {
          if (prev !== null) flashRound();
          loadMine(round);
        }
      }
      if (!open) endDrag();

      render();
      if (!pendingSeq) setStatus(idleStatus());
    },
    () => setStatus("Can't reach the server — refresh to retry", "error"),
  );
}

if (!configured) {
  setStatus("Not configured yet — see README", "error");
} else {
  onAuthStateChanged(auth, (user) => {
    if (user) {
      if (uid === null) {
        uid = user.uid;
        listen();
      }
    } else {
      signInAnonymously(auth).catch(() => setStatus("Couldn't connect — refresh to retry", "error"));
    }
  });
}
