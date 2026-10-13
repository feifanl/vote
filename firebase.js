import { firebaseConfig } from "./config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

export {
  onAuthStateChanged,
  signInAnonymously,
  signInWithPopup,
  signOut,
  GoogleAuthProvider,
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";

export {
  doc,
  collection,
  getDoc,
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
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

// Placeholder config: pages render a setup notice instead of failing deep inside the SDK.
export const configured = !firebaseConfig.apiKey.startsWith("YOUR_");

const app = configured ? initializeApp(firebaseConfig) : null;
export const auth = app && getAuth(app);
export const db = app && getFirestore(app);
