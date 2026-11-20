// firebase-config.js — Inisialisasi Firebase Modular v10+ via CDN
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// GANTI dengan konfigurasi dari Firebase Console > Project settings > Your apps (Web)
export const firebaseConfig = {
  apiKey: "AIzaSyB7isOppw7wBcqgLeHDxrYklkv2gLdsA8U",
  authDomain: "digitaku-dev-ade81.firebaseapp.com",
  projectId: "digitaku-dev-ade81",
  storageBucket: "digitaku-dev-ade81.firebasestorage.app",
  messagingSenderId: "497286689110",
  appId: "1:497286689110:web:3eeab4947037e6cbd526f7",
  measurementId: "G-82KBF47F22"
};

// URL backend home server (via Cloudflare Tunnel), tanpa trailing slash
export const API_BASE_URL = "https://desktop-e1c2168.note-theropod.ts.net";

export const STORAGE_LIMIT_BYTES = 64424509440; // 60 GB
export const CHUNK_SIZE = 5 * 1024 * 1024;      // 5 MB

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });

/* =====================================================================
   FIRESTORE SECURITY RULES YANG DISARANKAN (Firebase Console > Firestore > Rules)
   Admin pertama: ubah manual field role menjadi "admin" & status "approved"
   pada dokumen users/{uid} lewat Firebase Console.

rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function signedIn() { return request.auth != null; }
    function me() { return get(/databases/$(database)/documents/users/$(request.auth.uid)).data; }
    function isAdmin() {
      return signedIn()
        && exists(/databases/$(database)/documents/users/$(request.auth.uid))
        && me().role == 'admin' && me().status == 'approved';
    }
    function isApproved() {
      return signedIn()
        && exists(/databases/$(database)/documents/users/$(request.auth.uid))
        && me().status == 'approved';
    }

    match /users/{uid} {
      allow read: if signedIn() && (request.auth.uid == uid || isAdmin());
      // User baru hanya boleh membuat dokumen dirinya dengan nilai default aman
      allow create: if signedIn() && request.auth.uid == uid
        && request.resource.data.role == 'user'
        && request.resource.data.status == 'pending'
        && request.resource.data.storageUsed == 0
        && request.resource.data.storageLimit == 64424509440;
      // Hanya admin yang boleh mengubah status/role/kuota. storageUsed diubah backend (Admin SDK).
      allow update: if isAdmin();
      allow delete: if false;
    }

    // Metadata galeri: ditulis oleh backend (Admin SDK, melewati rules).
    match /media/{mediaId} {
      allow read: if isApproved() && (resource.data.ownerUid == request.auth.uid || isAdmin());
      allow write: if false;
    }

    // Telemetry server TIDAK lewat Firestore: frontend membaca langsung dari backend (GET /api/metrics & /api/metrics/stream).
  }
}

   Index komposit yang dibutuhkan: koleksi "media" -> ownerUid (Asc) + createdAt (Desc)
   (Firestore akan memberi link pembuatan index di console browser saat query pertama).
   ===================================================================== */
