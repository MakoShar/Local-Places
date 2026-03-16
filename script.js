/* ================================================================
   LocalPlaces — script.js
   Firebase auth, Firestore, recommendation engine, UI logic
   ================================================================ */

/* ------------------------------------------------------------------
   0.  FIREBASE CONFIG
   Replace these placeholder values with your Firebase project config.
   Get them from: Firebase Console → Project Settings → Your Apps
   ------------------------------------------------------------------ */
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyDGxwRl2_u-08BPiKMRIQZdedCKD5fE4CQ",
  authDomain:        "local-places-ba38e.firebaseapp.com",
  projectId:         "local-places-ba38e",
  storageBucket:     "local-places-ba38e.firebasestorage.app",
  messagingSenderId: "333390724166",
  appId:             "1:333390724166:web:b990e81c59b1590946de47"
};
/* ------------------------------------------------------------------
   1.  INIT
   ------------------------------------------------------------------ */
firebase.initializeApp(FIREBASE_CONFIG);
const auth = firebase.auth();
const db = firebase.firestore();
const storage = firebase.storage();

/* ------------------------------------------------------------------
   2.  APP STATE
   ------------------------------------------------------------------ */
let currentUser = null;   // Firebase User
let userData = null;   // Firestore user doc
let userLocation = null;   // { lat, lng }
let isGuest = false;  // anonymous session
let allPlaces = [];     // Loaded from Firestore
let activeFilter = 'all';
let obMap = null;   // Onboarding Google Map
let obMarker = null;
let selectedInterests = new Set();

/* ------------------------------------------------------------------
   3.  CONSTANTS
   ------------------------------------------------------------------ */
// Default profile used for anonymous (guest) sessions
const GUEST_DEFAULTS = {
  displayName: 'Guest Explorer',
  email: null,
  interests: ['walking', 'food', 'history', 'nature', 'art'],
  tagScores: { walking: 1, food: 1, history: 1, nature: 1, art: 1, cricket: 1, football: 1, fitness: 1, shopping: 1, music: 1 },
  location: null,
  points: 0,
  totalClicks: 0,
  onboardingComplete: true,
};

const INTERESTS = [
  { id: 'walking', emoji: '🚶', label: 'Walking & Running' },
  { id: 'football', emoji: '⚽', label: 'Football' },
  { id: 'cricket', emoji: '🏏', label: 'Cricket' },
  { id: 'food', emoji: '🍔', label: 'Food & Dining' },
  { id: 'history', emoji: '🏛️', label: 'History & Culture' },
  { id: 'art', emoji: '🎨', label: 'Art & Museums' },
  { id: 'nature', emoji: '🌿', label: 'Nature & Parks' },
  { id: 'shopping', emoji: '🛍️', label: 'Shopping' },
  { id: 'music', emoji: '🎵', label: 'Music & Events' },
  { id: 'fitness', emoji: '💪', label: 'Fitness & Gym' },
];

// Sample places for Indore, MP (seeded on first launch)
const SEED_PLACES = [
  {
    id: 'place_rajwada',
    name: 'Rajwada Palace',
    description: 'A majestic 7-story historic palace of the Holkar dynasty, right in the heart of the old city. A stunning blend of French, Mughal, and Maratha architecture.',
    imageUrl: 'https://images.unsplash.com/photo-1564507592333-c60657eea523?w=600&h=400&fit=crop&auto=format',
    tags: ['history', 'art', 'walking'],
    location: { lat: 22.7181, lng: 75.8580 },
    rating: 4.5, reviewCount: 2847, address: 'Rajwada, Indore, MP'
  },
  {
    id: 'place_lalbagh',
    name: 'Lal Bagh Palace',
    description: 'An opulent palace with European-style architecture surrounded by sprawling gardens. Home to three generations of Holkar kings.',
    imageUrl: 'https://images.unsplash.com/photo-1587474260584-136574528ed5?w=600&h=400&fit=crop&auto=format',
    tags: ['history', 'walking', 'art'],
    location: { lat: 22.7179, lng: 75.8527 },
    rating: 4.3, reviewCount: 1920, address: 'Lal Bagh, Indore, MP'
  },
  {
    id: 'place_sarafa',
    name: 'Sarafa Bazaar',
    description: 'India\'s most famous night food street — transforms into a food haven by night with 50+ street food stalls. Must try: garadu, poha, jalebi!',
    imageUrl: 'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=600&h=400&fit=crop&auto=format',
    tags: ['food', 'shopping'],
    location: { lat: 22.7184, lng: 75.8536 },
    rating: 4.7, reviewCount: 5312, address: 'Sarafa, Indore, MP'
  },
  {
    id: 'place_regional_park',
    name: 'Regional Park',
    description: 'A large green lung in the city — perfect for morning jogs, cycling, and evening walks. Features a mini-train, boating lake, and a fitness zone.',
    imageUrl: 'https://images.unsplash.com/photo-1501854140801-50d01698950b?w=600&h=400&fit=crop&auto=format',
    tags: ['walking', 'fitness', 'nature'],
    location: { lat: 22.7170, lng: 75.8820 },
    rating: 4.2, reviewCount: 1100, address: 'Regional Park, Indore, MP'
  },
  {
    id: 'place_gandhi_hall',
    name: 'Gandhi Hall',
    description: 'An iconic Indo-Gothic clock tower building and public hall — a symbol of Indore\'s colonial heritage and a popular photography spot.',
    imageUrl: 'https://images.unsplash.com/photo-1577036421869-7c8d388d2123?w=600&h=400&fit=crop&auto=format',
    tags: ['history', 'art'],
    location: { lat: 22.7201, lng: 75.8601 },
    rating: 4.1, reviewCount: 876, address: 'MG Road, Indore, MP'
  },
  {
    id: 'place_treasure',
    name: 'Treasure Island Mall',
    description: 'Indore\'s largest shopping mall with international brands, a multiplex, food court, and entertainment zone — the go-to weekend destination.',
    imageUrl: 'https://images.unsplash.com/photo-1555529669-e69e7aa0ba9a?w=600&h=400&fit=crop&auto=format',
    tags: ['shopping', 'food', 'music'],
    location: { lat: 22.7300, lng: 75.8858 },
    rating: 4.0, reviewCount: 3240, address: 'MG Road, Indore, MP'
  },
  {
    id: 'place_cricket',
    name: 'Holkar Cricket Stadium',
    description: 'One of the most picturesque cricket grounds in India. Watch live IPL and international matches at the home of MP cricket.',
    imageUrl: 'https://images.unsplash.com/photo-1531415074968-036ba1b575da?w=600&h=400&fit=crop&auto=format',
    tags: ['cricket', 'fitness'],
    location: { lat: 22.7640, lng: 75.8917 },
    rating: 4.6, reviewCount: 2100, address: 'Holkar Stadium, Indore, MP'
  },
  {
    id: 'place_football',
    name: 'City Indoor Football Arena',
    description: 'The best 5-a-side and 7-a-side football venue in Indore. Book a slot, join pickup games, and improve your game with weekend coaching sessions.',
    imageUrl: 'https://images.unsplash.com/photo-1551698618-1dfe5d97d256?w=600&h=400&fit=crop&auto=format',
    tags: ['football', 'fitness'],
    location: { lat: 22.7145, lng: 75.9012 },
    rating: 4.4, reviewCount: 512, address: 'Sports Complex, Indore, MP'
  },
  {
    id: 'place_chorahi',
    name: 'Chappan Dukan',
    description: '56 Shops lane — the legendary food street of Indore. From dahi-vada and mawa bati to pizza and momos, there\'s something for every appetite.',
    imageUrl: 'https://images.unsplash.com/photo-1606491956689-2ea866880c84?w=600&h=400&fit=crop&auto=format',
    tags: ['food', 'walking'],
    location: { lat: 22.7249, lng: 75.8832 },
    rating: 4.5, reviewCount: 4100, address: 'New Palasia, Indore, MP'
  },
  {
    id: 'place_central_museum',
    name: 'Central Museum Indore',
    description: 'Houses a magnificent collection of Parmar sculptures, Holkar-era artifacts, and ancient coins. A treasure trove for history and art enthusiasts.',
    imageUrl: 'https://images.unsplash.com/photo-1534430480872-3498386e7856?w=600&h=400&fit=crop&auto=format',
    tags: ['history', 'art'],
    location: { lat: 22.7199, lng: 75.8599 },
    rating: 3.9, reviewCount: 650, address: 'Agra-Bombay Road, Indore, MP'
  },
];

/* ------------------------------------------------------------------
   4.  UTILITY FUNCTIONS
   ------------------------------------------------------------------ */

/** Haversine distance in km */
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Format distance nicely */
function fmtDist(km) {
  return km < 1 ? `${Math.round(km * 1000)}m` : `${km.toFixed(1)}km`;
}

/** Show toast notification */
function showToast(msg, type = 'success', duration = 3000) {
  const toast = document.getElementById('toast');
  const icon = document.getElementById('toast-icon');
  document.getElementById('toast-msg').textContent = msg;
  toast.className = `toast show ${type}`;
  icon.className = type === 'success' ? 'fas fa-check-circle'
    : type === 'error' ? 'fas fa-times-circle'
      : 'fas fa-info-circle';
  setTimeout(() => { toast.classList.remove('show'); }, duration);
}

/** Hide loading screen after short delay */
function hideLoader() {
  setTimeout(() => {
    const el = document.getElementById('loading-screen');
    if (el) { el.style.opacity = '0'; el.style.transition = 'opacity 0.5s'; setTimeout(() => el.remove(), 500); }
  }, 1800);
}

/** Show a top-level view, hide others */
function showView(name) {
  ['auth-view', 'onboarding-view', 'app-view'].forEach(id => {
    document.getElementById(id).classList.toggle('hidden', id !== name + '-view' && id !== name);
  });
  if (name === 'app-view') document.getElementById('app-view').classList.remove('hidden');
}

auth.getRedirectResult().catch(err => {
  if (err?.code) showToast(friendlyAuthError(err.code), 'error');
});

/* ------------------------------------------------------------------
   5.  AUTH STATE LISTENER (main entry point)
   ------------------------------------------------------------------ */
auth.onAuthStateChanged(async user => {
  hideLoader();
  if (!user) { isGuest = false; showView('auth-view'); return; }

  currentUser = user;

  // --- Anonymous / Guest session ---
  if (user.isAnonymous) {
    isGuest = true;
    userData = { ...GUEST_DEFAULTS };
    showView('app-view');
    updateHeaderPoints();
    await seedPlacesIfNeeded();
    loadFeed();
    switchPage('feed', document.querySelector('[data-page="feed"]'));
    return;
  }

  // --- Registered user ---
  isGuest = false;
  try {
    const snap = await db.collection('users').doc(user.uid).get();
    if (!snap.exists || !snap.data().onboardingComplete) {
      showView('onboarding-view');
      initOnboarding();
    } else {
      userData = snap.data();
      userLocation = userData.location || null;
      showView('app-view');
      updateHeaderPoints();
      await seedPlacesIfNeeded();
      loadFeed();
      switchPage('feed', document.querySelector('[data-page="feed"]'));
    }
  } catch (e) {
    console.error('Auth state error', e);
    showToast('Connection error. Check Firebase config.', 'error');
    showView('auth-view');
  }
});

/* ------------------------------------------------------------------
   6.  AUTH HANDLERS
   ------------------------------------------------------------------ */
function switchAuthTab(tab) {
  document.getElementById('login-form').classList.toggle('hidden', tab !== 'login');
  document.getElementById('signup-form').classList.toggle('hidden', tab !== 'signup');
  document.getElementById('tab-login').classList.toggle('active', tab === 'login');
  document.getElementById('tab-signup').classList.toggle('active', tab === 'signup');
  document.getElementById('tab-slider').classList.toggle('right', tab === 'signup');
}

async function handleLogin(e) {
  e.preventDefault();
  const btn = document.getElementById('login-btn');
  btn.disabled = true; btn.innerHTML = '<div class="spinner" style="width:18px;height:18px;border-width:2px"></div>';
  try {
    await auth.signInWithEmailAndPassword(
      document.getElementById('login-email').value,
      document.getElementById('login-password').value
    );
  } catch (err) {
    showToast(friendlyAuthError(err.code), 'error');
    btn.disabled = false; btn.innerHTML = '<span>Sign In</span><i class="fas fa-arrow-right"></i>';
  }
}

async function handleSignup(e) {
  e.preventDefault();
  const btn = document.getElementById('signup-btn');
  btn.disabled = true; btn.innerHTML = '<div class="spinner" style="width:18px;height:18px;border-width:2px"></div>';
  try {
    const cred = await auth.createUserWithEmailAndPassword(
      document.getElementById('signup-email').value,
      document.getElementById('signup-password').value
    );
    await cred.user.updateProfile({ displayName: document.getElementById('signup-name').value.trim() });
  } catch (err) {
    showToast(friendlyAuthError(err.code), 'error');
    btn.disabled = false; btn.innerHTML = '<span>Create Account</span><i class="fas fa-arrow-right"></i>';
  }
}

async function handleGoogleAuth() {
  const provider = new firebase.auth.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });

  try {
    await auth.signInWithPopup(provider);
  } catch (err) {
    const popupFallbackCodes = new Set([
      'auth/popup-blocked',
      'auth/popup-closed-by-user',
      'auth/cancelled-popup-request'
    ]);

    if (popupFallbackCodes.has(err.code)) {
      try {
        await auth.signInWithRedirect(provider);
        return;
      } catch (redirectErr) {
        showToast(friendlyAuthError(redirectErr.code), 'error');
        return;
      }
    }

    showToast(friendlyAuthError(err.code), 'error');
  }
}

/** Sign in anonymously — no account needed */
async function handleGuestAuth() {
  const btn = document.querySelector('.btn-guest');
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner" style="width:16px;height:16px;border-width:2px"></div> Entering…';
  try {
    await auth.signInAnonymously();
  } catch (err) {
    showToast('Could not start guest session. Enable Anonymous Auth in Firebase.', 'error');
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-user-secret"></i> Use as Guest';
  }
}

async function handleLogout() {
  await auth.signOut();
  userData = null; userLocation = null; allPlaces = [];
}

function friendlyAuthError(code) {
  const map = {
    'auth/user-not-found': 'No account found for this email.',
    'auth/wrong-password': 'Incorrect password. Try again.',
    'auth/email-already-in-use': 'Email already registered. Sign in instead.',
    'auth/too-many-requests': 'Too many attempts. Wait a moment.',
    'auth/invalid-email': 'Enter a valid email address.',
    'auth/popup-closed-by-user': 'Sign-in popup closed.',
    'auth/popup-blocked': 'Popup was blocked. Allow popups and try again.',
    'auth/operation-not-allowed': 'Enable this sign-in method in Firebase Authentication.',
    'auth/unauthorized-domain': 'This domain is not allowed in Firebase Authorized Domains.',
  };
  return map[code] || 'Authentication failed. Check your connection.';
}

/* ------------------------------------------------------------------
   7.  ONBOARDING
   ------------------------------------------------------------------ */
function initOnboarding() {
  // Build interest chips
  const grid = document.getElementById('interests-grid');
  grid.innerHTML = '';
  INTERESTS.forEach(interest => {
    const chip = document.createElement('div');
    chip.className = 'interest-chip';
    chip.dataset.id = interest.id;
    chip.innerHTML = `<span class="interest-emoji">${interest.emoji}</span><span class="interest-label">${interest.label}</span>`;
    chip.addEventListener('click', () => toggleInterest(chip, interest.id));
    grid.appendChild(chip);
  });
  updateSelectedCount();

  // Init Maps when ready
  if (window._mapsReady) setupObMap();
  else window._onMapsReady = setupObMap;
}

function toggleInterest(chip, id) {
  if (selectedInterests.has(id)) { selectedInterests.delete(id); chip.classList.remove('selected'); }
  else { selectedInterests.add(id); chip.classList.add('selected'); }
  updateSelectedCount();
}

function updateSelectedCount() {
  const n = selectedInterests.size;
  document.getElementById('selected-count').textContent = `${n} selected`;
  document.getElementById('next-step-btn').disabled = n < 3;
}

function goToStep2() {
  document.getElementById('ob-step1').classList.add('hidden');
  document.getElementById('ob-step2').classList.remove('hidden');
  if (window._mapsReady) setupObMap();
  else window._onMapsReady = setupObMap;
}
function backToStep1() {
  document.getElementById('ob-step2').classList.add('hidden');
  document.getElementById('ob-step1').classList.remove('hidden');
}

function setupObMap() {
  if (obMap) return;
  const center = userLocation || { lat: 22.7196, lng: 75.8577 }; // default: Indore
  obMap = new google.maps.Map(document.getElementById('onboarding-map'), {
    center, zoom: 13,
    styles: darkMapStyle(),
    disableDefaultUI: true, zoomControl: true,
  });
  obMarker = new google.maps.Marker({ map: obMap, position: center, draggable: true });
  obMarker.addListener('dragend', e => setObLocation(e.latLng.lat(), e.latLng.lng()));
  obMap.addListener('click', e => {
    obMarker.setPosition(e.latLng);
    setObLocation(e.latLng.lat(), e.latLng.lng());
  });

  // Places autocomplete
  if (!window._mapsError) {
    const input = document.getElementById('location-search');
    const ac = new google.maps.places.Autocomplete(input);
    ac.addListener('place_changed', () => {
      const place = ac.getPlace();
      if (place.geometry) {
        const { lat, lng } = place.geometry.location;
        obMap.setCenter({ lat: lat(), lng: lng() });
        obMarker.setPosition({ lat: lat(), lng: lng() });
        setObLocation(lat(), lng(), place.formatted_address);
      }
    });
  }
}

function setObLocation(lat, lng, label) {
  userLocation = { lat, lng };
  const badge = document.getElementById('location-set-badge');
  badge.classList.remove('hidden');
  document.getElementById('location-display').textContent = label || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  document.getElementById('save-ob-btn').disabled = false;
}

async function detectLocation() {
  const btn = document.getElementById('detect-btn');
  btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> Detecting…';
  btn.disabled = true;
  if (!navigator.geolocation) { showToast('Geolocation not available', 'error'); return; }
  navigator.geolocation.getCurrentPosition(
    pos => {
      const { latitude: lat, longitude: lng } = pos.coords;
      setObLocation(lat, lng, 'Your current location');
      if (obMap) { obMap.setCenter({ lat, lng }); obMarker.setPosition({ lat, lng }); }
      btn.innerHTML = '<i class="fas fa-check"></i> Location Detected!';
      btn.style.background = 'rgba(16,185,129,0.18)'; btn.style.borderColor = 'var(--success)';
    },
    () => {
      showToast('Could not get location. Try manual search.', 'error');
      btn.innerHTML = '<i class="fas fa-crosshairs"></i> Use My Location';
      btn.disabled = false;
    }
  );
}

async function saveOnboarding() {
  const btn = document.getElementById('save-ob-btn');
  btn.disabled = true; btn.innerHTML = '<div class="spinner" style="width:16px;height:16px;border-width:2px;margin:0 auto"></div>';

  const initTagScores = {};
  selectedInterests.forEach(id => { initTagScores[id] = 3; }); // seed with 3 to prime recommendations

  try {
    await db.collection('users').doc(currentUser.uid).set({
      displayName: currentUser.displayName || 'Explorer',
      email: currentUser.email,
      photoURL: currentUser.photoURL || null,
      interests: [...selectedInterests],
      tagScores: initTagScores,
      location: userLocation,
      points: 0,
      totalClicks: 0,
      onboardingComplete: true,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    const snap = await db.collection('users').doc(currentUser.uid).get();
    userData = snap.data();
    showView('app-view');
    updateHeaderPoints();
    await seedPlacesIfNeeded();
    loadFeed();
  } catch (e) {
    console.error(e);
    showToast('Could not save profile. Check Firebase.', 'error');
    btn.disabled = false; btn.innerHTML = 'Let\'s Go! <i class="fas fa-rocket"></i>';
  }
}

/* ------------------------------------------------------------------
   8.  FEED — Recommendation Engine
   ------------------------------------------------------------------ */

/**
 * Score = Σ tagScore[tag] for each matching tag × (1 / max(dist_km, 0.05))
 * Higher interest score × closer distance = higher rank
 */
function computeScore(place, tagScores, uLat, uLng) {
  let tagSum = 0;
  (place.tags || []).forEach(t => { tagSum += (tagScores[t] || 0); });
  if (uLat && uLng) {
    const dist = haversineKm(uLat, uLng, place.location.lat, place.location.lng);
    return tagSum / Math.max(dist, 0.05);
  }
  return tagSum;
}

async function loadFeed() {
  const grid = document.getElementById('feed-grid');
  const loading = document.getElementById('feed-loading');
  const empty = document.getElementById('feed-empty');
  grid.innerHTML = ''; loading.classList.remove('hidden'); empty.classList.add('hidden');

  try {
    const snap = await db.collection('places').get();
    allPlaces = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Refresh userData in case tagScores changed
    const userSnap = await db.collection('users').doc(currentUser.uid).get();
    userData = userSnap.data();
    const tagScores = userData.tagScores || {};
    const uLat = userData.location?.lat;
    const uLng = userData.location?.lng;

    // Score & sort
    const scored = allPlaces.map(p => ({ ...p, _score: computeScore(p, tagScores, uLat, uLng) }));
    scored.sort((a, b) => b._score - a._score);

    loading.classList.add('hidden');
    renderFeed(scored, activeFilter, uLat, uLng);

    // Update feed subtitle
    if (uLat && uLng) document.getElementById('feed-sub').textContent = 'Nearest & most relevant to you';
  } catch (e) {
    console.error(e);
    loading.classList.add('hidden');
    showToast('Could not load feed. Check Firebase.', 'error');
  }
}

function renderFeed(places, filter, uLat, uLng) {
  const grid = document.getElementById('feed-grid');
  const empty = document.getElementById('feed-empty');
  grid.innerHTML = '';

  const filtered = filter === 'all' ? places : places.filter(p => p.tags?.includes(filter));
  if (!filtered.length) { empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');

  filtered.forEach(place => {
    const dist = (uLat && uLng) ? haversineKm(uLat, uLng, place.location.lat, place.location.lng) : null;
    const card = document.createElement('div');
    card.className = 'feed-card';
    card.innerHTML = `
      <img class="feed-card-img" src="${place.imageUrl}" alt="${place.name}" loading="lazy"
           onerror="this.src='https://picsum.photos/seed/${place.id}/600/400'" />
      <div class="feed-card-body">
        <div class="feed-card-name">${place.name}</div>
        <div class="feed-card-desc">${place.description}</div>
        <div class="feed-card-meta">
          <span class="feed-distance"><i class="fas fa-location-dot"></i>
            ${dist !== null ? fmtDist(dist) : 'Nearby'}
          </span>
          <span class="feed-rating"><i class="fas fa-star"></i> ${place.rating.toFixed(1)}</span>
        </div>
        <div class="feed-tags">
          ${(place.tags || []).map(t => `<span class="tag-pill">${t}</span>`).join('')}
        </div>
      </div>`;
    card.addEventListener('click', () => openPlaceModal(place, dist));
    grid.appendChild(card);
  });
}

function filterFeed(tag, btn) {
  activeFilter = tag;
  document.querySelectorAll('.fchip').forEach(c => c.classList.remove('active-chip'));
  btn.classList.add('active-chip');
  const tagScores = userData?.tagScores || {};
  const uLat = userData?.location?.lat, uLng = userData?.location?.lng;
  const scored = allPlaces.map(p => ({ ...p, _score: computeScore(p, tagScores, uLat, uLng) }));
  scored.sort((a, b) => b._score - a._score);
  renderFeed(scored, tag, uLat, uLng);
}

/* ------------------------------------------------------------------
   9.  PLACE MODAL & TAG INCREMENT
   ------------------------------------------------------------------ */
async function openPlaceModal(place, dist) {
  const modal = document.getElementById('place-modal');
  const body = document.getElementById('place-modal-body');
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  body.innerHTML = `
    <img class="modal-place-img" src="${place.imageUrl}" alt="${place.name}"
         onerror="this.src='https://picsum.photos/seed/${place.id}/600/400'" />
    <h2 class="modal-place-name">${place.name}</h2>
    <p class="modal-place-addr"><i class="fas fa-location-dot"></i>${place.address || 'Indore, MP'}</p>
    <p class="modal-place-desc">${place.description}</p>
    <div class="modal-meta-row">
      <span class="modal-badge badge-rating"><i class="fas fa-star"></i> ${place.rating.toFixed(1)} / 5</span>
      ${dist !== null ? `<span class="modal-badge badge-dist"><i class="fas fa-person-walking"></i> ${fmtDist(dist)} away</span>` : ''}
      <span class="modal-badge badge-reviews"><i class="fas fa-comment"></i> ${(place.reviewCount || 0).toLocaleString()} reviews</span>
    </div>
    <div class="modal-tag-track">
      ${(place.tags || []).map(t => `<span class="tag-pill">${t}</span>`).join('')}
    </div>`;

  // Increment tag scores (behavioral learning)
  // For guests: update in-memory only (not persisted)
  if (isGuest) {
    userData.totalClicks = (userData.totalClicks || 0) + 1;
    (place.tags || []).forEach(t => {
      userData.tagScores = userData.tagScores || {};
      userData.tagScores[t] = (userData.tagScores[t] || 0) + 1;
    });
  } else {
    try {
      const updates = {};
      (place.tags || []).forEach(t => { updates[`tagScores.${t}`] = firebase.firestore.FieldValue.increment(1); });
      updates['totalClicks'] = firebase.firestore.FieldValue.increment(1);
      await db.collection('users').doc(currentUser.uid).update(updates);
      if (userData) {
        userData.totalClicks = (userData.totalClicks || 0) + 1;
        (place.tags || []).forEach(t => {
          userData.tagScores = userData.tagScores || {};
          userData.tagScores[t] = (userData.tagScores[t] || 0) + 1;
        });
      }
    } catch (e) { console.warn('Tag increment failed', e); }
  }
}

function closePlaceModal(e) {
  if (e && e.target !== document.getElementById('place-modal') && !e.target.classList.contains('modal-close-btn')) return;
  document.getElementById('place-modal').classList.add('hidden');
  document.body.style.overflow = '';
}

/* ------------------------------------------------------------------
   10. VIDEOS PAGE
   ------------------------------------------------------------------ */
async function loadVideos() {
  const grid = document.getElementById('videos-grid');
  const loading = document.getElementById('videos-loading');
  const empty = document.getElementById('videos-empty');
  grid.innerHTML = ''; loading.classList.remove('hidden'); empty.classList.add('hidden');

  try {
    const snap = await db.collection('videos').orderBy('createdAt', 'desc').limit(30).get();
    loading.classList.add('hidden');
    if (snap.empty) { empty.classList.remove('hidden'); return; }

    snap.docs.forEach(d => {
      const v = { id: d.id, ...d.data() };
      const card = document.createElement('div');
      card.className = 'video-card';
      card.innerHTML = `
        <div class="video-thumb">
          <div class="video-thumb-placeholder">
            <i class="fas fa-play-circle"></i>
            <span>${v.placeName || 'Local Place'}</span>
          </div>
          <span class="video-badge">⭐ ${(v.placeRating || 0).toFixed(1)}</span>
          <span class="points-badge-vid"><i class="fas fa-star"></i>+${v.pointsAwarded || 10}</span>
          <div class="play-overlay"><i class="fas fa-play"></i></div>
        </div>
        <div class="video-info">
          <div class="video-place">${v.placeName || 'Unknown Place'}</div>
          <div class="video-uploader">@${v.uploaderName || 'explorer'}</div>
          ${v.caption ? `<div class="video-caption">${v.caption}</div>` : ''}
        </div>`;
      card.querySelector('.video-thumb').addEventListener('click', () => window.open(v.videoUrl, '_blank'));
      grid.appendChild(card);
    });
  } catch (e) {
    console.error(e);
    loading.classList.add('hidden');
    showToast('Could not load videos.', 'error');
  }
}

function openUploadModal() {
  // Guests cannot upload — prompt them to sign up
  if (isGuest) {
    showToast('Create a free account to upload videos & earn points!', 'info', 4000);
    setTimeout(() => {
      auth.signOut(); // exit guest session → goes to auth page
    }, 1200);
    return;
  }
  const modal = document.getElementById('upload-modal');
  // Populate place dropdown
  const sel = document.getElementById('upload-place');
  sel.innerHTML = '<option value="">Choose a place…</option>';
  allPlaces.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id; opt.textContent = p.name;
    opt.dataset.rating = p.rating;
    sel.appendChild(opt);
  });
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeUploadModal(e) {
  if (e && e.target !== document.getElementById('upload-modal') && !e.target.classList.contains('modal-close-btn')) return;
  document.getElementById('upload-modal').classList.add('hidden');
  document.body.style.overflow = '';
  document.getElementById('upload-form').reset();
  document.getElementById('file-preview-wrap').classList.add('hidden');
  document.getElementById('upload-progress-wrap').classList.add('hidden');
}

function handleFileSelect(e) {
  const file = e.target.files[0];
  const preview = document.getElementById('file-preview-wrap');
  if (file) {
    preview.classList.remove('hidden');
    preview.innerHTML = `<i class="fas fa-check-circle"></i> ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`;
  }
}

async function handleVideoUpload(e) {
  e.preventDefault();
  const placeId = document.getElementById('upload-place').value;
  const fileInp = document.getElementById('video-file-input');
  const caption = document.getElementById('upload-caption').value.trim();
  const file = fileInp.files[0];

  if (!placeId || !file) { showToast('Select a place and a video file.', 'error'); return; }

  const sel = document.getElementById('upload-place');
  const opt = sel.querySelector(`option[value="${placeId}"]`);
  const place = allPlaces.find(p => p.id === placeId);

  const submitBtn = document.getElementById('upload-submit');
  const progressWrap = document.getElementById('upload-progress-wrap');
  const progressFill = document.getElementById('upload-progress-fill');
  const progressTxt = document.getElementById('upload-progress-txt');

  submitBtn.disabled = true;
  progressWrap.classList.remove('hidden');

  try {
    // Upload to Firebase Storage
    const path = `videos/${currentUser.uid}/${Date.now()}_${file.name}`;
    const ref = storage.ref(path);
    const task = ref.put(file);

    task.on('state_changed',
      snap => {
        const pct = (snap.bytesTransferred / snap.totalBytes * 100).toFixed(0);
        progressFill.style.width = pct + '%';
        progressTxt.textContent = `Uploading… ${pct}%`;
      },
      err => { throw err; },
      async () => {
        const url = await ref.getDownloadURL();
        // Save metadata to Firestore
        await db.collection('videos').add({
          userId: currentUser.uid,
          uploaderName: (currentUser.displayName || 'explorer').toLowerCase().replace(/\s+/, ''),
          placeId,
          placeName: place?.name || 'Unknown',
          placeRating: place?.rating || 0,
          videoUrl: url,
          caption,
          pointsAwarded: 10,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
        // Award points
        await db.collection('users').doc(currentUser.uid).update({
          points: firebase.firestore.FieldValue.increment(10)
        });
        if (userData) userData.points = (userData.points || 0) + 10;
        updateHeaderPoints();

        showToast('🎉 Video shared! +10 points earned!', 'success', 4000);
        closeUploadModal();
        loadVideos();
      }
    );
  } catch (err) {
    console.error(err);
    showToast('Upload failed. Check Firebase Storage CORS settings.', 'error');
    submitBtn.disabled = false;
    progressWrap.classList.add('hidden');
  }
}

/* ------------------------------------------------------------------
   11. PROFILE PAGE
   ------------------------------------------------------------------ */
async function loadProfile() {
  // Guest profile — render from in-memory GUEST_DEFAULTS
  if (isGuest) {
    renderGuestProfile();
    return;
  }
  try {
    const snap = await db.collection('users').doc(currentUser.uid).get();
    userData = snap.data();

    document.getElementById('profile-name').textContent = userData.displayName || 'Explorer';
    document.getElementById('profile-email-txt').textContent = userData.email || '';
    document.getElementById('stat-points').textContent = (userData.points || 0).toLocaleString();
    document.getElementById('stat-explored').textContent = (userData.totalClicks || 0).toLocaleString();

    // Avatar
    if (currentUser.photoURL) {
      document.getElementById('profile-avatar').innerHTML = `<img src="${currentUser.photoURL}" alt="avatar" />`;
    }

    // My videos count
    const videoSnap = await db.collection('videos').where('userId', '==', currentUser.uid).get();
    document.getElementById('stat-videos').textContent = videoSnap.size;

    // Render videos grid
    const pvGrid = document.getElementById('profile-videos-grid');
    pvGrid.innerHTML = '';
    if (videoSnap.empty) {
      document.getElementById('profile-no-videos').classList.remove('hidden');
    } else {
      document.getElementById('profile-no-videos').classList.add('hidden');
      videoSnap.docs.forEach(d => {
        const v = d.data();
        const div = document.createElement('div');
        div.className = 'profile-v-thumb';
        div.innerHTML = `<i class="fas fa-play-circle"></i>`;
        div.title = v.placeName;
        div.addEventListener('click', () => window.open(v.videoUrl, '_blank'));
        pvGrid.appendChild(div);
      });
    }

    // Interests
    const intRow = document.getElementById('profile-interests');
    intRow.innerHTML = (userData.interests || []).map(id => {
      const found = INTERESTS.find(i => i.id === id);
      return found ? `<span class="tag-pill">${found.emoji} ${found.label}</span>` : '';
    }).join('');

    // Tag score bars
    renderTagBars(userData.tagScores || {});

  } catch (e) { console.error(e); }
}

function renderGuestProfile() {
  document.getElementById('profile-name').textContent = 'Guest Explorer';
  document.getElementById('profile-email-txt').textContent = 'Browsing as guest';
  document.getElementById('stat-points').textContent = '—';
  document.getElementById('stat-videos').textContent = '—';
  document.getElementById('stat-explored').textContent = (userData.totalClicks || 0).toLocaleString();

  // Guest CTA banner
  const section = document.getElementById('profile-page');
  if (!document.getElementById('guest-banner')) {
    const banner = document.createElement('div');
    banner.id = 'guest-banner';
    banner.style.cssText = `
      background: var(--accent-soft); border: 1px solid var(--accent);
      border-radius: var(--r-lg); padding: 16px 18px; margin: 0 0 16px;
      display:flex; flex-direction:column; gap:10px;
    `;
    banner.innerHTML = `
      <p style="font-size:14px;font-weight:700;color:var(--text-1)">
        <i class="fas fa-user-secret" style="color:var(--accent)"></i>
        You're browsing as a Guest
      </p>
      <p style="font-size:13px;color:var(--text-2);line-height:1.5">
        Create a free account to save your preferences, earn points, and upload videos.
      </p>
      <button onclick="auth.signOut()" style="
        padding:10px; border-radius:var(--r-full); border:none; cursor:pointer;
        background:linear-gradient(135deg,var(--accent),#a855f7);
        color:#fff; font-size:14px; font-weight:700;
      "><i class="fas fa-user-plus"></i> Create Free Account</button>`;
    section.insertBefore(banner, section.firstChild);
  }

  renderTagBars(userData.tagScores || {});
  document.getElementById('profile-interests').innerHTML =
    (userData.interests || []).map(id => {
      const f = INTERESTS.find(i => i.id === id);
      return f ? `<span class="tag-pill">${f.emoji} ${f.label}</span>` : '';
    }).join('');
  document.getElementById('profile-no-videos').classList.remove('hidden');
}

function renderTagBars(scores) {
  const el = document.getElementById('profile-tag-bars');
  el.innerHTML = '';
  const entries = Object.entries(scores).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (!entries.length) { el.innerHTML = '<p style="color:var(--text-3);font-size:13px">Explore places to build your profile!</p>'; return; }
  const max = entries[0][1];
  entries.forEach(([tag, val]) => {
    const pct = Math.round(val / max * 100);
    const info = INTERESTS.find(i => i.id === tag);
    el.innerHTML += `
      <div class="tag-bar-item">
        <div class="tag-bar-label">
          <span>${info ? info.emoji + ' ' + info.label : tag}</span>
          <span>${val} pts</span>
        </div>
        <div class="tag-bar-track"><div class="tag-bar-fill" style="width:${pct}%"></div></div>
      </div>`;
  });
}

/* ------------------------------------------------------------------
   12. NAVIGATION
   ------------------------------------------------------------------ */
function switchPage(page, btn) {
  document.querySelectorAll('.app-page').forEach(s => {
    s.classList.remove('active-page');
    s.classList.add('hidden');
  });
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

  const pageEl = document.getElementById(`${page}-page`);
  if (pageEl) { pageEl.classList.remove('hidden'); pageEl.classList.add('active-page'); }

  if (btn) { btn.classList.add('active'); }
  else {
    const navBtn = document.querySelector(`.nav-btn[data-page="${page}"]`);
    if (navBtn) navBtn.classList.add('active');
  }

  if (page === 'videos') loadVideos();
  if (page === 'profile') loadProfile();
}

function updateHeaderPoints() {
  const pts = userData?.points || 0;
  document.getElementById('hdr-points').textContent = pts.toLocaleString();
}

/* ------------------------------------------------------------------
   13. SEED SAMPLE DATA
   ------------------------------------------------------------------ */
async function seedPlacesIfNeeded() {
  try {
    const snap = await db.collection('places').limit(1).get();
    if (!snap.empty) return; // already seeded
    const batch = db.batch();
    SEED_PLACES.forEach(p => {
      const ref = db.collection('places').doc(p.id);
      batch.set(ref, p);
    });
    await batch.commit();
    console.log('✅ Sample places seeded!');
  } catch (e) { console.warn('Seeding skipped:', e.message); }
}

/* ------------------------------------------------------------------
   14. GOOGLE MAPS DARK STYLE
   ------------------------------------------------------------------ */
function darkMapStyle() {
  return [
    { elementType: 'geometry', stylers: [{ color: '#1a1a2e' }] },
    { elementType: 'labels.text.fill', stylers: [{ color: '#8b8ba7' }] },
    { elementType: 'labels.text.stroke', stylers: [{ color: '#111120' }] },
    { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2a2a40' }] },
    { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#111120' }] },
    { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0e1628' }] },
    { featureType: 'poi', elementType: 'geometry', stylers: [{ color: '#1e1e35' }] },
    { featureType: 'transit', elementType: 'geometry', stylers: [{ color: '#1e1e35' }] },
  ];
}
