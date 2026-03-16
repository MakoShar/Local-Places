/* ================================================================
   LocalPlaces — script.js
   Local auth, local storage recommendation engine, UI logic
   ================================================================ */

/* ------------------------------------------------------------------
   0.  LOCAL-ONLY MODE
   Firebase has been removed. Data/auth are stored in browser localStorage.
   ------------------------------------------------------------------ */

/* ------------------------------------------------------------------
   1.  INIT
   ------------------------------------------------------------------ */
const LOCAL_FIELD_VALUE = {
  serverTimestamp: () => new Date().toISOString(),
  increment: (n) => n,
};

const db = {
  collection() {
    throw new Error('Cloud database removed. App runs in local mode only.');
  },
  batch() {
    throw new Error('Cloud database removed. App runs in local mode only.');
  }
};

const storage = {
  ref() {
    throw new Error('Cloud storage removed. App runs in local mode only.');
  }
};

/* ------------------------------------------------------------------
   2.  APP STATE
   ------------------------------------------------------------------ */
let currentUser = null;   // local auth user
let userData = null;   // local user profile
let userLocation = null;   // { lat, lng }
let isGuest = false;  // anonymous session
let backendMode = 'local'; // always local
let allPlaces = [];     // Loaded from local seed/mock sources
let activeFilter = 'all';
let obMap = null;   // Onboarding Google Map
let obMarker = null;
let selectedInterests = new Set();

const LOCAL_USER_KEY_PREFIX = 'localplaces_user_';
const LOGIN_INFO_KEY = 'localplaces_login_info';
const AUTH_USERS_KEY = 'localplaces_auth_users';
const AUTH_SESSION_KEY = 'localplaces_auth_session';
const AUTH_BOOTSTRAP_FLAG_KEY = 'localplaces_auth_bootstrapped_v1';
const localAuthListeners = [];
let localAuthCurrentUser = null;
let authBootstrapPromise = null;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function hashPassword(password) {
  return btoa(unescape(encodeURIComponent(String(password || ''))));
}

function readAuthUsers() {
  try {
    const raw = localStorage.getItem(AUTH_USERS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAuthUsers(users) {
  localStorage.setItem(AUTH_USERS_KEY, JSON.stringify(users));
}

async function bootstrapAuthUsersFromTemplate(force = false) {
  if (authBootstrapPromise) return authBootstrapPromise;

  authBootstrapPromise = (async () => {
    try {
      if (!force) {
        const alreadyBootstrapped = localStorage.getItem(AUTH_BOOTSTRAP_FLAG_KEY) === '1';
        if (alreadyBootstrapped) return;
      }

      const existing = readAuthUsers();
      if (!force && existing.length) {
        localStorage.setItem(AUTH_BOOTSTRAP_FLAG_KEY, '1');
        return;
      }

      const response = await fetch('login-info.json', { cache: 'no-store' });
      if (!response.ok) return;

      const payload = await response.json();
      const templateUsers = Array.isArray(payload?.users) ? payload.users : [];
      if (!templateUsers.length) {
        localStorage.setItem(AUTH_BOOTSTRAP_FLAG_KEY, '1');
        return;
      }

      const seeded = [...existing];
      templateUsers.forEach((u, idx) => {
        const email = normalizeEmail(u?.emailId || u?.email);
        const password = String(u?.password || '');
        if (!email || !password) return;
        if (seeded.some(existingUser => existingUser.email === email)) return;

        seeded.push({
          uid: String(u?.userId || u?.uid || `seed_${idx}_${Math.random().toString(36).slice(2, 8)}`),
          email,
          displayName: String(u?.name || email.split('@')[0] || 'Explorer'),
          password,
          passwordHash: hashPassword(password),
          accountCreatedDate: String(u?.accountCreatedDate || new Date().toISOString()),
        });
      });

      if (seeded.length !== existing.length) writeAuthUsers(seeded);
      localStorage.setItem(AUTH_BOOTSTRAP_FLAG_KEY, '1');
    } catch {
      // Ignore bootstrap failures; app can still run with sign-up flow.
    } finally {
      authBootstrapPromise = null;
    }
  })();

  return authBootstrapPromise;
}

function saveAuthSession(user) {
  if (!user) {
    localStorage.removeItem(AUTH_SESSION_KEY);
    return;
  }
  localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify({
    uid: user.uid,
    isAnonymous: !!user.isAnonymous,
  }));
}

function makeAuthUser(record, isAnonymous = false) {
  return {
    uid: record.uid,
    email: record.email || null,
    displayName: record.displayName || 'Explorer',
    photoURL: null,
    isAnonymous,
    providerData: [{ providerId: isAnonymous ? 'anonymous' : 'password' }],
    async updateProfile(profile) {
      const users = readAuthUsers();
      const idx = users.findIndex(u => u.uid === record.uid);
      if (idx >= 0) {
        users[idx].displayName = profile?.displayName || users[idx].displayName;
        writeAuthUsers(users);
      }
      this.displayName = profile?.displayName || this.displayName;
      if (localAuthCurrentUser?.uid === this.uid) localAuthCurrentUser = this;
    }
  };
}

function emitLocalAuthState() {
  localAuthListeners.forEach(cb => cb(localAuthCurrentUser));
}

function hydrateLocalAuthSession() {
  try {
    const raw = localStorage.getItem(AUTH_SESSION_KEY);
    if (!raw) return;
    const session = JSON.parse(raw);
    if (session?.isAnonymous) {
      localAuthCurrentUser = makeAuthUser({ uid: session.uid, displayName: 'Guest Explorer' }, true);
      return;
    }
    const users = readAuthUsers();
    const found = users.find(u => u.uid === session?.uid);
    if (found) localAuthCurrentUser = makeAuthUser(found, false);
  } catch {
    localAuthCurrentUser = null;
  }
}

const auth = {
  async getRedirectResult() {
    return { user: null };
  },
  onAuthStateChanged(callback) {
    localAuthListeners.push(callback);
    callback(localAuthCurrentUser);
    return () => {
      const idx = localAuthListeners.indexOf(callback);
      if (idx >= 0) localAuthListeners.splice(idx, 1);
    };
  },
  async signInWithEmailAndPassword(email, password) {
    const normalized = normalizeEmail(email);
    await bootstrapAuthUsersFromTemplate();

    const users = readAuthUsers();
    const found = users.find(u => u.email === normalized);
    if (!found) {
      const err = new Error('No account found');
      err.code = 'auth/user-not-found';
      throw err;
    }

    const hashed = hashPassword(password);
    const matchesHash = found.passwordHash === hashed;
    const matchesLegacyPlain = found.password && found.password === String(password || '');

    if (!matchesHash && !matchesLegacyPlain) {
      const err = new Error('Wrong password');
      err.code = 'auth/wrong-password';
      throw err;
    }

    if (!matchesHash && matchesLegacyPlain) {
      // Upgrade legacy plain-password records to hashed verification.
      const idx = users.findIndex(u => u.uid === found.uid);
      if (idx >= 0) {
        users[idx].passwordHash = hashed;
        writeAuthUsers(users);
      }
    }

    localAuthCurrentUser = makeAuthUser(found, false);
    saveAuthSession(localAuthCurrentUser);
    emitLocalAuthState();
    return { user: localAuthCurrentUser };
  },
  async createUserWithEmailAndPassword(email, password) {
    const normalized = normalizeEmail(email);
    if (!normalized || !normalized.includes('@')) {
      const err = new Error('Invalid email');
      err.code = 'auth/invalid-email';
      throw err;
    }
    if (String(password || '').length < 6) {
      const err = new Error('Weak password');
      err.code = 'auth/weak-password';
      throw err;
    }

    const users = readAuthUsers();
    if (users.some(u => u.email === normalized)) {
      const err = new Error('Email already exists');
      err.code = 'auth/email-already-in-use';
      throw err;
    }

    const record = {
      uid: `local_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      email: normalized,
      displayName: normalized.split('@')[0],
      password: String(password || ''),
      passwordHash: hashPassword(password),
      accountCreatedDate: new Date().toISOString(),
    };
    users.push(record);
    writeAuthUsers(users);

    localAuthCurrentUser = makeAuthUser(record, false);
    saveAuthSession(localAuthCurrentUser);
    emitLocalAuthState();
    return { user: localAuthCurrentUser };
  },
  async signInWithPopup() {
    const err = new Error('Google login disabled in local mode');
    err.code = 'auth/operation-not-allowed';
    throw err;
  },
  async signInWithRedirect() {
    const err = new Error('Google login disabled in local mode');
    err.code = 'auth/operation-not-allowed';
    throw err;
  },
  async signInAnonymously() {
    localAuthCurrentUser = makeAuthUser({
      uid: `guest_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      displayName: 'Guest Explorer',
      email: null,
    }, true);
    saveAuthSession(localAuthCurrentUser);
    emitLocalAuthState();
    return { user: localAuthCurrentUser };
  },
  async signOut() {
    localAuthCurrentUser = null;
    saveAuthSession(null);
    emitLocalAuthState();
  }
};

hydrateLocalAuthSession();
bootstrapAuthUsersFromTemplate();

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

const ANALYTICS_KEY_PREFIX = 'localplaces_analytics_';
const COMMUNITY_POSTS_KEY = 'localplaces_community_posts';
const REALITY_FEED_KEY = 'localplaces_reality_feed';
const CUSTOM_WORK_KEY = 'localplaces_custom_work';
const VACANCIES_KEY = 'localplaces_vacancies';
const PERSONAL_FILTER_KEY_PREFIX = 'localplaces_personal_filter_';

const CATEGORY_SEARCH_CONFIG = {
  food: { label: 'Food / Pizza', emoji: '🍕', keyword: 'pizza restaurant', type: 'restaurant' },
  shopping: { label: 'Shopping', emoji: '🛍️', keyword: 'shopping mall store', type: 'shopping_mall' },
  fitness: { label: 'Fitness', emoji: '💪', keyword: 'gym fitness', type: 'gym' },
  football: { label: 'Football', emoji: '⚽', keyword: 'football turf', type: 'stadium' },
  cricket: { label: 'Cricket', emoji: '🏏', keyword: 'cricket ground', type: 'stadium' },
  walking: { label: 'Parks', emoji: '🚶', keyword: 'park walking', type: 'park' },
  nature: { label: 'Nature', emoji: '🌿', keyword: 'garden nature park', type: 'park' },
  history: { label: 'History', emoji: '🏛️', keyword: 'museum historical place', type: 'museum' },
  art: { label: 'Art', emoji: '🎨', keyword: 'art gallery museum', type: 'art_gallery' },
  music: { label: 'Music', emoji: '🎵', keyword: 'music venue cafe', type: 'cafe' },
};

const CATEGORY_FALLBACK_REQUESTS = {
  shopping: [
    { keyword: 'shopping mall store', type: 'shopping_mall' },
    { keyword: 'shoe store' },
    { keyword: 'clothing store' },
    { keyword: 'grocery supermarket' },
  ],
  food: [
    { keyword: 'pizza restaurant', type: 'restaurant' },
    { keyword: 'restaurant' },
    { keyword: 'cafe food' },
  ],
};

const CATEGORY_TAG_HINTS = {
  fitness: ['Gym', 'Workout'],
  walking: ['Park', 'Hiking Place'],
  nature: ['Nature Spot', 'Green Area'],
  food: ['Restaurant', 'Food Spot'],
  shopping: ['Shopping Place', 'Retail'],
  football: ['Football Ground', 'Sports'],
  cricket: ['Cricket Ground', 'Sports'],
  history: ['Historical Place', 'Heritage'],
  art: ['Art Place', 'Gallery'],
  music: ['Music Venue', 'Live Spot'],
};

const nearbyPlaceCache = new Map();
let placesServiceMapInstance = null;

const PRODUCT_CATALOG = [
  { id: 'p1', name: 'Sports Running Shoes', category: 'fitness', site: 'Amazon', url: 'https://www.amazon.in/s?k=running+shoes', price: 'INR 1,999+' },
  { id: 'p2', name: 'Football Training Kit', category: 'football', site: 'Flipkart', url: 'https://www.flipkart.com/search?q=football+training+kit', price: 'INR 899+' },
  { id: 'p3', name: 'Cricket Bat Combo', category: 'cricket', site: 'Amazon', url: 'https://www.amazon.in/s?k=cricket+bat+set', price: 'INR 1,499+' },
  { id: 'p4', name: 'Cafe Bluetooth Speaker', category: 'music', site: 'Flipkart', url: 'https://www.flipkart.com/search?q=bluetooth+speaker', price: 'INR 1,299+' },
  { id: 'p5', name: 'Travel Backpack', category: 'walking', site: 'Amazon', url: 'https://www.amazon.in/s?k=travel+backpack', price: 'INR 1,099+' },
  { id: 'p6', name: 'Restaurant POS Tablet', category: 'food', site: 'IndiaMART', url: 'https://dir.indiamart.com/search.mp?ss=restaurant+pos+machine', price: 'INR 8,000+' },
  { id: 'p7', name: 'Decor Lights for Events', category: 'art', site: 'Amazon', url: 'https://www.amazon.in/s?k=decor+lights+party', price: 'INR 799+' },
  { id: 'p8', name: 'Cafe Outdoor Plants', category: 'nature', site: 'NurseryLive', url: 'https://nurserylive.com/collections/outdoor-plants', price: 'INR 299+' },
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

function localUserKey(uid) {
  return `${LOCAL_USER_KEY_PREFIX}${uid}`;
}

function makeLocalUserData(user) {
  return {
    ...GUEST_DEFAULTS,
    displayName: user?.displayName || 'Explorer',
    email: user?.email || null,
    photoURL: user?.photoURL || null,
    onboardingComplete: false,
  };
}

function loadLocalUserData(uid) {
  try {
    const raw = localStorage.getItem(localUserKey(uid));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveLocalUserData(uid, data) {
  try {
    localStorage.setItem(localUserKey(uid), JSON.stringify(data));
  } catch (e) {
    console.warn('Could not persist local user data', e);
  }
}

function readLoginInfoStore() {
  try {
    const raw = localStorage.getItem(LOGIN_INFO_KEY);
    if (!raw) {
      return {
        version: 1,
        description: 'Login records with one-time personalization. Export this as login-info.json.',
        users: []
      };
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.users)) parsed.users = [];
    return parsed;
  } catch {
    return {
      version: 1,
      description: 'Login records with one-time personalization. Export this as login-info.json.',
      users: []
    };
  }
}

function writeLoginInfoStore(store) {
  try {
    localStorage.setItem(LOGIN_INFO_KEY, JSON.stringify(store));
  } catch (e) {
    console.warn('Could not persist login info store', e);
  }
}

function normalizeProvider(user) {
  if (user?.isAnonymous) return 'anonymous';
  const providerId = user?.providerData?.[0]?.providerId || 'unknown';
  const map = {
    'google.com': 'google',
    'password': 'email',
    'phone': 'phone',
    'github.com': 'github'
  };
  return map[providerId] || providerId;
}

function trackLoginInfo(user) {
  if (!user?.uid) return;

  const store = readLoginInfoStore();
  const authUsers = readAuthUsers();
  const authRec = authUsers.find(u => u.uid === user.uid);
  const now = new Date().toISOString();
  const idx = store.users.findIndex(u => (u.userId || u.uid) === user.uid);
  const next = {
    userId: user.uid,
    name: user.displayName || authRec?.displayName || 'Explorer',
    emailId: user.email || authRec?.email || null,
    password: authRec?.password || null,
    accountCreatedDate: authRec?.accountCreatedDate || now,
    oneTimePersonalization: null,
    isGuest: !!user.isAnonymous,
    provider: normalizeProvider(user),
    lastLoginAt: now,
  };

  if (idx >= 0) {
    const prev = store.users[idx];
    store.users[idx] = {
      ...prev,
      ...next,
      accountCreatedDate: prev.accountCreatedDate || next.accountCreatedDate,
      oneTimePersonalization: prev.oneTimePersonalization || next.oneTimePersonalization,
    };
  } else {
    store.users.push(next);
  }

  writeLoginInfoStore(store);
}

function updateSidebarProfile() {
  const nameEl = document.getElementById('sidebar-profile-name');
  const emailEl = document.getElementById('sidebar-profile-email');
  const avatarEl = document.getElementById('sidebar-profile-avatar');
  if (!nameEl || !emailEl || !avatarEl) return;

  const name = currentUser?.displayName || userData?.displayName || 'User';
  const email = currentUser?.email || userData?.email || 'guest@localplaces';
  nameEl.textContent = name;
  emailEl.textContent = email;
  avatarEl.textContent = String(name).trim().charAt(0).toUpperCase() || 'U';
}

function openSettingsModal() {
  const modal = document.getElementById('settings-modal');
  if (!modal) return;

  document.getElementById('settings-name').value = currentUser?.displayName || userData?.displayName || '';
  document.getElementById('settings-email').value = currentUser?.email || userData?.email || '';
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeSettingsModal(e) {
  if (e && e.target !== document.getElementById('settings-modal') && !e.target.classList.contains('modal-close-btn')) return;
  const modal = document.getElementById('settings-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  document.body.style.overflow = '';
}

function saveProfileSettings(e) {
  e.preventDefault();
  const nextName = document.getElementById('settings-name').value.trim();
  const nextEmail = document.getElementById('settings-email').value.trim().toLowerCase();

  if (!nextName || !nextEmail) {
    showToast('Name and email are required.', 'error');
    return;
  }

  const users = readAuthUsers();
  const idx = users.findIndex(u => u.uid === currentUser?.uid);
  if (idx >= 0) {
    users[idx].displayName = nextName;
    users[idx].email = nextEmail;
    writeAuthUsers(users);
  }

  if (currentUser) {
    currentUser.displayName = nextName;
    currentUser.email = nextEmail;
  }

  if (userData) {
    userData.displayName = nextName;
    userData.email = nextEmail;
    if (currentUser?.uid) saveLocalUserData(currentUser.uid, userData);
  }

  trackLoginInfo(currentUser);
  updateSidebarProfile();
  closeSettingsModal();
  showToast('Profile settings updated.', 'success');
}

function setOneTimePersonalizationForCurrentUser(interests, location) {
  if (!currentUser?.uid) return;
  const store = readLoginInfoStore();
  const idx = store.users.findIndex(u => (u.userId || u.uid) === currentUser.uid);
  if (idx < 0) return;

  store.users[idx].oneTimePersonalization = {
    interests: Array.isArray(interests) ? interests : [],
    location: location || null,
    savedAt: new Date().toISOString(),
  };
  writeLoginInfoStore(store);
}

function exportLoginInfoJson() {
  const store = readLoginInfoStore();
  const blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'login-info.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast('login-info.json exported.', 'success');
}

function isBillingOrFirestoreBlockedError(err) {
  const msg = (err?.message || '').toLowerCase();
  const code = err?.code || '';
  return code === 'permission-denied'
    || code === 'unavailable'
    || msg.includes('cloud firestore api has not been used')
    || msg.includes('requires billing')
    || msg.includes('err_blocked_by_client')
    || msg.includes('client is offline');
}

function enableLocalMode(err) {
  if (backendMode === 'local') return;
  backendMode = 'local';
  console.warn('Switching to local mode:', err?.message || err);
  showToast('Running in local-only mode.', 'info', 5500);
}

auth.getRedirectResult().catch(err => {
  if (err?.code) showToast(friendlyAuthError(err.code), 'error');
});

/* ------------------------------------------------------------------
   5.  AUTH STATE LISTENER (main entry point)
   ------------------------------------------------------------------ */
auth.onAuthStateChanged(async user => {
  hideLoader();
  if (!user) {
    isGuest = false;
    backendMode = 'local';
    showView('auth-view');
    return;
  }

  currentUser = user;
  trackLoginInfo(user);

  // --- Anonymous / Guest session ---
  if (user.isAnonymous) {
    isGuest = true;
    userData = { ...GUEST_DEFAULTS };
    showView('app-view');
    updateHeaderPoints();
    await seedPlacesIfNeeded();
    loadFeed();
    initHackathonDashboard();
    switchPage('home', document.querySelector('[data-page="home"]'));
    updateSidebarProfile();
    return;
  }

  // --- Registered user ---
  isGuest = false;

  if (backendMode === 'local') {
    userData = loadLocalUserData(user.uid) || makeLocalUserData(user);
    userLocation = userData.location || null;
    if (!userData.onboardingComplete) {
      showView('onboarding-view');
      initOnboarding();
    } else {
      showView('app-view');
      updateHeaderPoints();
      loadFeed();
      initHackathonDashboard();
      switchPage('home', document.querySelector('[data-page="home"]'));
      updateSidebarProfile();
    }
    return;
  }

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
      initHackathonDashboard();
      switchPage('home', document.querySelector('[data-page="home"]'));
      updateSidebarProfile();
    }
  } catch (e) {
    console.error('Auth state error', e);
    if (isBillingOrFirestoreBlockedError(e)) {
      enableLocalMode(e);
      userData = loadLocalUserData(user.uid) || makeLocalUserData(user);
      userLocation = userData.location || null;
      if (!userData.onboardingComplete) {
        showView('onboarding-view');
        initOnboarding();
      } else {
        showView('app-view');
        updateHeaderPoints();
        loadFeed();
        initHackathonDashboard();
        switchPage('home', document.querySelector('[data-page="home"]'));
        updateSidebarProfile();
      }
      return;
    }

      showToast(friendlyDataError(e, 'Connection error. Please reload the app.'), 'error', 5000);
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

  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;

  try {
    await auth.signInWithEmailAndPassword(email, password);
  } catch (err) {
    const code = err?.code || '';

    if (code === 'auth/user-not-found') {
      showToast('No account found on this site. Sign up first, or use a seeded demo account from login-info.json.', 'info', 5000);
      switchAuthTab('signup');
      document.getElementById('signup-email').value = email;
      if (!document.getElementById('signup-name').value.trim()) {
        document.getElementById('signup-name').value = email.split('@')[0] || 'Explorer';
      }
    } else {
      showToast(friendlyAuthError(code), 'error');
    }
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span>Sign In</span><i class="fas fa-arrow-right"></i>';
  }
}

async function handleSignup(e) {
  e.preventDefault();
  const btn = document.getElementById('signup-btn');
  btn.disabled = true; btn.innerHTML = '<div class="spinner" style="width:18px;height:18px;border-width:2px"></div>';
  try {
    const signupName = document.getElementById('signup-name').value.trim();
    const cred = await auth.createUserWithEmailAndPassword(
      document.getElementById('signup-email').value,
      document.getElementById('signup-password').value
    );
    await cred.user.updateProfile({ displayName: signupName });
    trackLoginInfo(cred.user);
  } catch (err) {
    showToast(friendlyAuthError(err.code), 'error');
    btn.disabled = false; btn.innerHTML = '<span>Create Account</span><i class="fas fa-arrow-right"></i>';
  }
}

async function handleGoogleAuth() {
  showToast('Google login removed. Use Sign Up with email and password.', 'info', 4500);
  switchAuthTab('signup');
}

/** Sign in anonymously — no account needed */
async function handleGuestAuth() {
  const btn = document.querySelector('.btn-guest');
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner" style="width:16px;height:16px;border-width:2px"></div> Entering…';
  try {
    await auth.signInAnonymously();
  } catch (err) {
    showToast('Could not start guest session. Please try again.', 'error');
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
    'auth/invalid-credential': 'Invalid email or password.',
    'auth/invalid-login-credentials': 'Invalid email or password.',
    'auth/wrong-password': 'Incorrect password. Try again.',
    'auth/user-disabled': 'This account has been disabled.',
    'auth/email-already-in-use': 'Email already registered. Sign in instead.',
    'auth/weak-password': 'Password must be at least 6 characters.',
    'auth/too-many-requests': 'Too many attempts. Wait a moment.',
    'auth/invalid-email': 'Enter a valid email address.',
    'auth/api-key-not-valid': 'Auth configuration is invalid for this deployment.',
    'auth/network-request-failed': 'Network blocked or unavailable. Check internet/adblock.',
    'auth/popup-closed-by-user': 'Sign-in popup closed.',
    'auth/popup-blocked': 'Popup was blocked. Allow popups and try again.',
    'auth/operation-not-allowed': 'This sign-in method is not allowed for this deployment.',
    'auth/unauthorized-domain': 'This domain is not authorized for this deployment.',
  };
  return map[code] || 'Authentication failed. Check your connection.';
}

function friendlyDataError(err, fallback = 'Request failed.') {
  const msg = (err?.message || '').toLowerCase();
  const code = err?.code || '';

  if (code === 'permission-denied' || msg.includes('cloud firestore api has not been used') || msg.includes('requires billing')) {
    return 'Cloud sync is unavailable. App is running in local mode.';
  }
  if (msg.includes('err_blocked_by_client')) {
    return 'Requests are blocked by browser extension/adblock. Disable blocker for this site and reload.';
  }
  if (msg.includes('offline') || msg.includes('network') || code === 'unavailable') {
    return 'Network issue detected. Check internet and reload.';
  }

  return fallback;
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

  // If Maps never loads (blocked key/adblock), reveal manual fallback UI.
  setTimeout(() => {
    if (!window._mapsReady) handleMapsUnavailable();
  }, 1200);
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

  setTimeout(() => {
    if (!window._mapsReady) handleMapsUnavailable();
  }, 1200);
}
function backToStep1() {
  document.getElementById('ob-step2').classList.add('hidden');
  document.getElementById('ob-step1').classList.remove('hidden');
}

function setupObMap() {
  if (window._mapsError || typeof google === 'undefined' || !google.maps) {
    handleMapsUnavailable();
    return;
  }

  if (obMap) return;
  try {
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
  } catch (e) {
    console.warn('Google Maps setup failed', e);
    window._mapsError = true;
    handleMapsUnavailable();
  }
}

function handleMapsUnavailable() {
  const mapContainer = document.getElementById('map-container');
  const help = document.getElementById('maps-help');
  const search = document.getElementById('location-search');
  if (!mapContainer || !help || !search) return;

  mapContainer.classList.add('hidden');
  help.classList.remove('hidden');
  search.disabled = true;
  search.placeholder = 'Maps unavailable. Use manual latitude and longitude below.';
}

function setManualLocation() {
  const lat = parseFloat(document.getElementById('manual-lat').value);
  const lng = parseFloat(document.getElementById('manual-lng').value);
  const label = document.getElementById('manual-label').value.trim();

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    showToast('Enter valid latitude and longitude.', 'error');
    return;
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    showToast('Latitude must be -90 to 90 and longitude -180 to 180.', 'error');
    return;
  }

  setObLocation(lat, lng, label || `${lat.toFixed(4)}, ${lng.toFixed(4)}`);

  if (obMap && obMarker) {
    obMap.setCenter({ lat, lng });
    obMarker.setPosition({ lat, lng });
  }
  showToast('Manual location set.', 'success');
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

  if (backendMode === 'local') {
    userData = {
      ...(userData || makeLocalUserData(currentUser)),
      displayName: currentUser.displayName || 'Explorer',
      email: currentUser.email,
      photoURL: currentUser.photoURL || null,
      interests: [...selectedInterests],
      tagScores: initTagScores,
      location: userLocation,
      points: userData?.points || 0,
      totalClicks: userData?.totalClicks || 0,
      onboardingComplete: true,
    };
    saveLocalUserData(currentUser.uid, userData);
    setOneTimePersonalizationForCurrentUser([...selectedInterests], userLocation);
    showView('app-view');
    updateHeaderPoints();
    loadFeed();
    initHackathonDashboard();
    switchPage('home', document.querySelector('[data-page="home"]'));
    return;
  }

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
      createdAt: LOCAL_FIELD_VALUE.serverTimestamp(),
    });
    const snap = await db.collection('users').doc(currentUser.uid).get();
    userData = snap.data();
    setOneTimePersonalizationForCurrentUser([...selectedInterests], userLocation);
    showView('app-view');
    updateHeaderPoints();
    await seedPlacesIfNeeded();
    loadFeed();
  } catch (e) {
    console.error(e);
    if (isBillingOrFirestoreBlockedError(e)) {
      enableLocalMode(e);
      userData = {
        ...(userData || makeLocalUserData(currentUser)),
        displayName: currentUser.displayName || 'Explorer',
        email: currentUser.email,
        photoURL: currentUser.photoURL || null,
        interests: [...selectedInterests],
        tagScores: initTagScores,
        location: userLocation,
        points: userData?.points || 0,
        totalClicks: userData?.totalClicks || 0,
        onboardingComplete: true,
      };
      saveLocalUserData(currentUser.uid, userData);
      setOneTimePersonalizationForCurrentUser([...selectedInterests], userLocation);
      showView('app-view');
      updateHeaderPoints();
      loadFeed();
      initHackathonDashboard();
      switchPage('home', document.querySelector('[data-page="home"]'));
      return;
    }

    showToast(friendlyDataError(e, 'Could not save profile locally.'), 'error', 5000);
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
  const personalizedRoot = document.getElementById('personalized-filters');

  // New hackathon home dashboard: source recommendations from Google Places.
  if (personalizedRoot) {
    renderPersonalizedFilters();
    const saved = localStorage.getItem(personalFilterKey()) || getPreferredCategories()[0] || 'food';
    await selectPersonalizedFilter(saved, null, false);
    return;
  }

  grid.innerHTML = ''; loading.classList.remove('hidden'); empty.classList.add('hidden');

  if (backendMode === 'local') {
    allPlaces = [...SEED_PLACES];
    const tagScores = userData?.tagScores || {};
    const uLat = userData?.location?.lat;
    const uLng = userData?.location?.lng;
    const scored = allPlaces.map(p => ({ ...p, _score: computeScore(p, tagScores, uLat, uLng) }));
    scored.sort((a, b) => b._score - a._score);
    loading.classList.add('hidden');
    renderFeed(scored, activeFilter, uLat, uLng);
    return;
  }

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
    if (isBillingOrFirestoreBlockedError(e)) {
      enableLocalMode(e);
      allPlaces = [...SEED_PLACES];
      const tagScores = userData?.tagScores || {};
      const uLat = userData?.location?.lat;
      const uLng = userData?.location?.lng;
      const scored = allPlaces.map(p => ({ ...p, _score: computeScore(p, tagScores, uLat, uLng) }));
      scored.sort((a, b) => b._score - a._score);
      loading.classList.add('hidden');
      renderFeed(scored, activeFilter, uLat, uLng);
      return;
    }

    loading.classList.add('hidden');
    showToast(friendlyDataError(e, 'Could not load feed right now.'), 'error', 5000);
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
  if (isGuest || backendMode === 'local') {
    userData.totalClicks = (userData.totalClicks || 0) + 1;
    (place.tags || []).forEach(t => {
      userData.tagScores = userData.tagScores || {};
      userData.tagScores[t] = (userData.tagScores[t] || 0) + 1;
    });
    if (!isGuest && currentUser?.uid) saveLocalUserData(currentUser.uid, userData);
  } else {
    try {
      const updates = {};
      (place.tags || []).forEach(t => { updates[`tagScores.${t}`] = LOCAL_FIELD_VALUE.increment(1); });
      updates['totalClicks'] = LOCAL_FIELD_VALUE.increment(1);
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

  if (backendMode === 'local') {
    loading.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }

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

  if (backendMode === 'local') {
    showToast('Video upload is unavailable in local-only mode.', 'info', 5000);
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
    // Upload to remote storage backend
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
        // Save metadata to backend
        await db.collection('videos').add({
          userId: currentUser.uid,
          uploaderName: (currentUser.displayName || 'explorer').toLowerCase().replace(/\s+/, ''),
          placeId,
          placeName: place?.name || 'Unknown',
          placeRating: place?.rating || 0,
          videoUrl: url,
          caption,
          pointsAwarded: 10,
          createdAt: LOCAL_FIELD_VALUE.serverTimestamp(),
        });
        // Award points
        await db.collection('users').doc(currentUser.uid).update({
          points: LOCAL_FIELD_VALUE.increment(10)
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
    showToast('Upload failed.', 'error');
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

  if (backendMode === 'local') {
    const local = loadLocalUserData(currentUser.uid) || makeLocalUserData(currentUser);
    userData = local;

    document.getElementById('profile-name').textContent = userData.displayName || 'Explorer';
    document.getElementById('profile-email').textContent = userData.email || '';
    document.getElementById('stat-points').textContent = (userData.points || 0).toLocaleString();
    document.getElementById('stat-explored').textContent = (userData.totalClicks || 0).toLocaleString();
    document.getElementById('stat-videos').textContent = '0';
    document.getElementById('profile-no-videos').classList.remove('hidden');

    if (currentUser.photoURL) {
      document.getElementById('profile-avatar').innerHTML = `<img src="${currentUser.photoURL}" alt="avatar" />`;
    }

    const intRow = document.getElementById('profile-interests');
    intRow.innerHTML = (userData.interests || []).map(id => {
      const found = INTERESTS.find(i => i.id === id);
      return found ? `<span class="tag-pill">${found.emoji} ${found.label}</span>` : '';
    }).join('');

    renderTagBars(userData.tagScores || {});
    return;
  }
  try {
    const snap = await db.collection('users').doc(currentUser.uid).get();
    userData = snap.data();

    document.getElementById('profile-name').textContent = userData.displayName || 'Explorer';
    document.getElementById('profile-email').textContent = userData.email || '';
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
  document.getElementById('profile-email').textContent = 'Browsing as guest';
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
function analyticsKey(uid) {
  return `${ANALYTICS_KEY_PREFIX}${uid || 'guest'}`;
}

function readJsonArray(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeJsonArray(key, arr) {
  localStorage.setItem(key, JSON.stringify(arr));
}

function getAnalytics() {
  const uid = currentUser?.uid || 'guest';
  try {
    const raw = localStorage.getItem(analyticsKey(uid));
    if (!raw) return { views: 0, purchases: 0, categoryCounts: {} };
    const parsed = JSON.parse(raw);
    return {
      views: parsed.views || 0,
      purchases: parsed.purchases || 0,
      categoryCounts: parsed.categoryCounts || {}
    };
  } catch {
    return { views: 0, purchases: 0, categoryCounts: {} };
  }
}

function saveAnalytics(analytics) {
  const uid = currentUser?.uid || 'guest';
  localStorage.setItem(analyticsKey(uid), JSON.stringify(analytics));
}

function bumpProductMetric(type, category) {
  const analytics = getAnalytics();
  if (type === 'view') analytics.views += 1;
  if (type === 'purchase') analytics.purchases += 1;
  if (category) analytics.categoryCounts[category] = (analytics.categoryCounts[category] || 0) + 1;
  saveAnalytics(analytics);
  renderPersonalizedMetrics();
}

function renderPersonalizedMetrics() {
  const kpiViews = document.getElementById('kpi-views');
  const kpiPurchases = document.getElementById('kpi-purchases');
  const kpiTop = document.getElementById('kpi-top');
  if (!kpiViews || !kpiPurchases || !kpiTop) return;

  const analytics = getAnalytics();
  kpiViews.textContent = analytics.views.toLocaleString();
  kpiPurchases.textContent = analytics.purchases.toLocaleString();

  const top = Object.entries(analytics.categoryCounts)
    .sort((a, b) => b[1] - a[1])[0]?.[0];
  kpiTop.textContent = top || 'None';
}

function rankProductsByQuery(query) {
  const q = String(query || '').toLowerCase();
  const scored = PRODUCT_CATALOG.map(item => {
    let score = 0;
    if (q.includes(item.category)) score += 3;
    if (q.includes(item.name.toLowerCase().split(' ')[0])) score += 2;
    if (item.name.toLowerCase().includes(q)) score += 4;
    if (q.includes('party') && item.category === 'art') score += 2;
    if (q.includes('restaurant') && item.category === 'food') score += 2;
    if (q.includes('cafe') && (item.category === 'food' || item.category === 'music')) score += 2;
    return { ...item, score };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, 6);
}

function renderChatResults(items) {
  const root = document.getElementById('chat-results');
  if (!root) return;
  root.innerHTML = '';

  if (!items.length) {
    root.innerHTML = '<p class="panel-sub">No products found. Try another query.</p>';
    return;
  }

  items.forEach(item => {
    const card = document.createElement('div');
    card.className = 'product-card';
    card.innerHTML = `
      <h4>${item.name}</h4>
      <p>${item.site} • ${item.price} • ${item.category}</p>
      <div class="product-actions">
        <button class="btn-mini" onclick="trackProductView('${item.id}')">View</button>
        <a class="btn-mini" href="${item.url}" target="_blank" rel="noopener" onclick="trackProductPurchase('${item.id}')">Open Dashboard</a>
      </div>`;
    root.appendChild(card);
  });
}

function handleProductChat(e) {
  e.preventDefault();
  const query = document.getElementById('chat-query').value.trim();
  renderChatResults(rankProductsByQuery(query));
  showToast('AI suggestions updated.', 'success', 1800);
}

function trackProductView(productId) {
  const item = PRODUCT_CATALOG.find(p => p.id === productId);
  bumpProductMetric('view', item?.category);
  if (item?.category) selectPersonalizedFilter(item.category);
}

function trackProductPurchase(productId) {
  const item = PRODUCT_CATALOG.find(p => p.id === productId);
  bumpProductMetric('purchase', item?.category);
  if (item?.category) selectPersonalizedFilter(item.category);
}

function personalFilterKey() {
  return `${PERSONAL_FILTER_KEY_PREFIX}${currentUser?.uid || 'guest'}`;
}

function getPreferredCategories() {
  const analytics = getAnalytics();
  const fromAnalytics = Object.entries(analytics.categoryCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k)
    .filter(k => CATEGORY_SEARCH_CONFIG[k]);

  const fromInterests = (userData?.interests || []).filter(k => CATEGORY_SEARCH_CONFIG[k]);
  const defaults = ['food', 'shopping', 'fitness'];

  return [...new Set([...fromAnalytics, ...fromInterests, ...defaults])].slice(0, 8);
}

function renderPersonalizedFilters() {
  const root = document.getElementById('personalized-filters');
  if (!root) return;
  const categories = getPreferredCategories();
  root.innerHTML = '';
  categories.forEach(category => {
    const cfg = CATEGORY_SEARCH_CONFIG[category];
    const btn = document.createElement('button');
    btn.className = 'fchip';
    btn.dataset.category = category;
    btn.innerHTML = `${cfg.emoji} ${cfg.label}`;
    btn.onclick = () => selectPersonalizedFilter(category, btn);
    root.appendChild(btn);
  });
}

function getPlacesService() {
  if (!window.google || !google.maps || !google.maps.places) return null;
  if (placesServiceMapInstance) return placesServiceMapInstance;

  let hiddenMapEl = document.getElementById('hidden-places-map');
  if (!hiddenMapEl) {
    hiddenMapEl = document.createElement('div');
    hiddenMapEl.id = 'hidden-places-map';
    hiddenMapEl.style.cssText = 'width:1px;height:1px;position:fixed;left:-9999px;top:-9999px;';
    document.body.appendChild(hiddenMapEl);
  }

  const center = userData?.location || { lat: 22.7196, lng: 75.8577 };
  placesServiceMapInstance = new google.maps.Map(hiddenMapEl, { center, zoom: 14 });
  return placesServiceMapInstance;
}

function nearbySearchPromise(request) {
  return new Promise((resolve, reject) => {
    const map = getPlacesService();
    if (!map) {
      reject(new Error('Google Maps unavailable'));
      return;
    }
    const service = new google.maps.places.PlacesService(map);
    service.nearbySearch(request, (results, status) => {
      if (status === google.maps.places.PlacesServiceStatus.OK || status === google.maps.places.PlacesServiceStatus.ZERO_RESULTS) {
        resolve(results || []);
      } else {
        reject(new Error(status));
      }
    });
  });
}

async function searchNearbyByCategory(category, center, options = {}) {
  const cfg = CATEGORY_SEARCH_CONFIG[category] || CATEGORY_SEARCH_CONFIG.food;
  const openNow = !!options.openNow;
  const radius = options.radius || 7000;

  const fallbackRequests = CATEGORY_FALLBACK_REQUESTS[category] || [
    { keyword: cfg.keyword, type: cfg.type },
    { keyword: cfg.keyword },
  ];

  const requests = fallbackRequests.map(req => {
    const baseReq = {
      location: new google.maps.LatLng(center.lat, center.lng),
      radius,
      keyword: req.keyword || cfg.keyword,
    };
    if (req.type) baseReq.type = req.type;
    if (openNow) baseReq.openNow = true;
    return baseReq;
  });

  const settled = await Promise.allSettled(requests.map(r => nearbySearchPromise(r)));
  const merged = [];
  settled.forEach(item => {
    if (item.status === 'fulfilled' && Array.isArray(item.value)) {
      merged.push(...item.value);
    }
  });

  const deduped = [];
  const seen = new Set();
  merged.forEach(place => {
    if (!place?.place_id || seen.has(place.place_id)) return;
    seen.add(place.place_id);
    deduped.push(place);
  });

  deduped.sort((a, b) => {
    const ratingDiff = (b.rating || 0) - (a.rating || 0);
    if (ratingDiff !== 0) return ratingDiff;
    return (b.user_ratings_total || 0) - (a.user_ratings_total || 0);
  });

  return deduped;
}

function placeDetailsPromise(placeId) {
  return new Promise((resolve, reject) => {
    const map = getPlacesService();
    if (!map) {
      reject(new Error('Google Maps unavailable'));
      return;
    }
    const service = new google.maps.places.PlacesService(map);
    service.getDetails({
      placeId,
      fields: ['name', 'rating', 'formatted_address', 'opening_hours', 'website', 'formatted_phone_number', 'photos', 'geometry', 'price_level']
    }, (result, status) => {
      if (status === google.maps.places.PlacesServiceStatus.OK) resolve(result);
      else reject(new Error(status));
    });
  });
}

function getPhotoUrl(place) {
  if (place?.photos?.[0]) {
    return place.photos[0].getUrl({ maxWidth: 800, maxHeight: 500 });
  }
  return 'https://picsum.photos/seed/localplace/800/500';
}

function formatPlaceTypeTag(type) {
  const map = {
    gym: 'Gym',
    park: 'Park',
    hiking_area: 'Hiking Place',
    campground: 'Camping Spot',
    restaurant: 'Restaurant',
    cafe: 'Cafe',
    bakery: 'Bakery',
    shopping_mall: 'Shopping Mall',
    supermarket: 'Supermarket',
    stadium: 'Stadium',
    museum: 'Museum',
    art_gallery: 'Art Gallery',
    tourist_attraction: 'Tourist Spot',
  };
  if (map[type]) return map[type];
  return String(type || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function getPlaceTagsForCard(place, category) {
  const tags = [];
  const categoryLabel = CATEGORY_SEARCH_CONFIG[category]?.label;
  if (categoryLabel) {
    tags.push(categoryLabel.split('/')[0].trim());
  }

  const hints = CATEGORY_TAG_HINTS[category] || [];
  hints.forEach(h => tags.push(h));

  (place?.types || [])
    .filter(t => t !== 'point_of_interest' && t !== 'establishment')
    .slice(0, 3)
    .forEach(t => tags.push(formatPlaceTypeTag(t)));

  return [...new Set(tags)].slice(0, 4);
}

async function selectPersonalizedFilter(category, btn, trackInteraction = true) {
  const root = document.getElementById('personalized-filters');
  if (root) {
    root.querySelectorAll('.fchip').forEach(b => b.classList.remove('active-chip'));
    const target = btn || root.querySelector(`[data-category="${category}"]`);
    if (target) target.classList.add('active-chip');
  }

  localStorage.setItem(personalFilterKey(), category);
  if (trackInteraction) bumpProductMetric('view', category);
  await loadNearbyPlacesByCategory(category);
}

async function loadNearbyPlacesByCategory(category) {
  const loading = document.getElementById('feed-loading');
  const empty = document.getElementById('feed-empty');
  const grid = document.getElementById('feed-grid');
  const hint = document.getElementById('personalized-hint');
  const otherSection = document.getElementById('other-open-section');
  const otherGrid = document.getElementById('other-open-grid');
  const otherLoading = document.getElementById('other-open-loading');
  const otherEmpty = document.getElementById('other-open-empty');
  if (!loading || !empty || !grid) return;

  loading.classList.remove('hidden');
  empty.classList.add('hidden');
  grid.innerHTML = '';
  if (otherSection && otherGrid && otherLoading && otherEmpty) {
    otherSection.classList.remove('hidden');
    otherGrid.innerHTML = '';
    otherLoading.classList.remove('hidden');
    otherEmpty.classList.add('hidden');
  }

  const cfg = CATEGORY_SEARCH_CONFIG[category] || CATEGORY_SEARCH_CONFIG.food;
  if (hint) hint.textContent = `Showing nearby ${cfg.label} places from Google Maps (open and closed).`;

  if (!window.google || !google.maps || !google.maps.places || window._mapsError) {
    loading.classList.add('hidden');
    empty.classList.remove('hidden');
    empty.querySelector('p').textContent = 'Google Maps unavailable. Use manual location or allow Maps.';
    if (otherSection && otherGrid && otherLoading && otherEmpty) {
      otherLoading.classList.add('hidden');
      otherGrid.innerHTML = '';
      otherEmpty.classList.remove('hidden');
      otherEmpty.textContent = 'Google Maps unavailable, so nearby shops cannot be loaded.';
    }
    return;
  }

  const center = userData?.location || { lat: 22.7196, lng: 75.8577 };
  try {
    const results = await searchNearbyByCategory(category, center, { radius: 9000, openNow: false });

    results.forEach(place => nearbyPlaceCache.set(place.place_id, place));
    loading.classList.add('hidden');
    const selectedIds = renderNearbyPlaces(results, category);
    await loadOtherOpenPlaces(category, selectedIds);
  } catch (e) {
    console.warn('Nearby search failed', e);
    loading.classList.add('hidden');
    empty.classList.remove('hidden');
    empty.querySelector('p').textContent = 'Could not load nearby shops from Google Maps.';
    if (otherSection && otherGrid && otherLoading && otherEmpty) {
      otherLoading.classList.add('hidden');
      otherGrid.innerHTML = '';
      otherEmpty.classList.remove('hidden');
      otherEmpty.textContent = 'Could not load nearby shops from Google Maps.';
    }
  }
}

function renderNearbyPlaces(places, category) {
  const grid = document.getElementById('feed-grid');
  const empty = document.getElementById('feed-empty');
  if (!grid || !empty) return;

  const topPlaces = (places || []).slice(0, 18);
  if (!topPlaces.length) {
    empty.classList.remove('hidden');
    empty.querySelector('p').textContent = 'No nearby places found for this filter.';
    return [];
  }

  empty.classList.add('hidden');
  grid.innerHTML = '';
  topPlaces.forEach(place => {
    const openNow = place.opening_hours?.open_now;
    const statusText = openNow === true ? 'Open now' : openNow === false ? 'Closed now' : 'Status unknown';
    const tags = getPlaceTagsForCard(place, category);
    const card = document.createElement('div');
    card.className = 'feed-card';
    card.innerHTML = `
      <img class="feed-card-img" src="${getPhotoUrl(place)}" alt="${place.name}" loading="lazy" />
      <div class="feed-card-body">
        <div class="feed-card-name">${place.name}</div>
        <div class="feed-card-desc">${place.vicinity || 'Nearby place'}</div>
        <div class="feed-card-meta">
          <span class="feed-rating"><i class="fas fa-star"></i> ${(place.rating || 0).toFixed(1)}</span>
          <span class="feed-distance"><i class="fas fa-store"></i> ${statusText}</span>
        </div>
        <div class="feed-tags">
          ${tags.map(tag => `<span class="tag-pill">${tag}</span>`).join('')}
        </div>
        <div class="product-actions" style="margin-top:8px;">
          <button class="btn-mini" onclick="openNearbyPlaceDashboard('${place.place_id}','${category}')">Open Dashboard</button>
        </div>
      </div>`;
    grid.appendChild(card);
  });

  return topPlaces.map(place => place.place_id);
}

async function loadOtherOpenPlaces(selectedCategory, selectedPlaceIds = []) {
  const otherSection = document.getElementById('other-open-section');
  const otherGrid = document.getElementById('other-open-grid');
  const otherLoading = document.getElementById('other-open-loading');
  const otherEmpty = document.getElementById('other-open-empty');
  if (!otherSection || !otherGrid || !otherLoading || !otherEmpty) return;

  const center = userData?.location || { lat: 22.7196, lng: 75.8577 };
  const selectedIds = new Set(selectedPlaceIds || []);
  const categories = Object.keys(CATEGORY_SEARCH_CONFIG);

  try {
    const resultsByCategory = await Promise.all(
      categories.map(async category => {
        try {
          const places = await searchNearbyByCategory(category, center, { radius: 9000, openNow: false });
          return (places || []).map(place => ({ ...place, _sourceCategory: category }));
        } catch {
          return [];
        }
      })
    );

    const merged = resultsByCategory.flat();
    const deduped = [];
    const seen = new Set();
    merged.forEach(place => {
      if (!place?.place_id || seen.has(place.place_id) || selectedIds.has(place.place_id)) return;
      seen.add(place.place_id);
      nearbyPlaceCache.set(place.place_id, place);
      deduped.push(place);
    });

    deduped.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    renderOtherOpenPlaces(deduped);
  } finally {
    otherLoading.classList.add('hidden');
  }
}

function renderOtherOpenPlaces(places) {
  const otherGrid = document.getElementById('other-open-grid');
  const otherEmpty = document.getElementById('other-open-empty');
  if (!otherGrid || !otherEmpty) return;

  otherGrid.innerHTML = '';
  if (!places.length) {
    otherEmpty.classList.remove('hidden');
    return;
  }

  otherEmpty.classList.add('hidden');
  places.forEach(place => {
    const category = place._sourceCategory || 'food';
    const openNow = place.opening_hours?.open_now;
    const statusText = openNow === true ? 'Open now' : openNow === false ? 'Closed now' : 'Status unknown';
    const tags = getPlaceTagsForCard(place, category);
    const card = document.createElement('div');
    card.className = 'feed-card secondary-card';
    card.innerHTML = `
      <img class="feed-card-img" src="${getPhotoUrl(place)}" alt="${place.name}" loading="lazy" />
      <div class="feed-card-body">
        <div class="feed-card-name">${place.name}</div>
        <div class="feed-card-desc">${place.vicinity || 'Nearby place'}</div>
        <div class="feed-card-meta">
          <span class="feed-rating"><i class="fas fa-star"></i> ${(place.rating || 0).toFixed(1)}</span>
          <span class="feed-distance"><i class="fas fa-store"></i> ${statusText}</span>
        </div>
        <div class="feed-tags">
          ${tags.map(tag => `<span class="tag-pill">${tag}</span>`).join('')}
        </div>
        <div class="product-actions" style="margin-top:8px;">
          <button class="btn-mini" onclick="openNearbyPlaceDashboard('${place.place_id}','${category}')">Open Dashboard</button>
        </div>
      </div>`;
    otherGrid.appendChild(card);
  });
}

async function openNearbyPlaceDashboard(placeId, category) {
  const base = nearbyPlaceCache.get(placeId);
  if (!base) return;

  let detail = base;
  try {
    detail = await placeDetailsPromise(placeId);
  } catch (e) {
    console.warn('Place details fallback', e);
  }

  const modal = document.getElementById('place-modal');
  const body = document.getElementById('place-modal-body');
  if (!modal || !body) return;

  const lat = detail.geometry?.location?.lat ? detail.geometry.location.lat() : null;
  const lng = detail.geometry?.location?.lng ? detail.geometry.location.lng() : null;
  const directionsUrl = lat !== null && lng !== null
    ? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(detail.name)}`;

  body.innerHTML = `
    <img class="modal-place-img" src="${getPhotoUrl(detail)}" alt="${detail.name}" />
    <h2 class="modal-place-name">${detail.name}</h2>
    <p class="modal-place-addr"><i class="fas fa-location-dot"></i>${detail.formatted_address || base.vicinity || 'Nearby area'}</p>
    <p class="modal-place-desc">Top match for your <strong>${category}</strong> preference. Live listing powered by Google Maps nearby search.</p>
    <div class="modal-meta-row">
      <span class="modal-badge badge-rating"><i class="fas fa-star"></i> ${(detail.rating || 0).toFixed(1)} / 5</span>
      <span class="modal-badge badge-reviews"><i class="fas fa-phone"></i> ${detail.formatted_phone_number || 'Contact unavailable'}</span>
    </div>
    <div class="product-actions" style="margin-top:12px;">
      <a class="btn-mini" href="${directionsUrl}" target="_blank" rel="noopener">Get Directions</a>
      ${detail.website ? `<a class="btn-mini" href="${detail.website}" target="_blank" rel="noopener">Website</a>` : ''}
    </div>`;

  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function submitCommunityPost(e) {
  e.preventDefault();
  const place = document.getElementById('form-place').value.trim();
  const type = document.getElementById('form-type').value;
  const message = document.getElementById('form-message').value.trim();
  const posts = readJsonArray(COMMUNITY_POSTS_KEY);
  posts.unshift({
    id: `f_${Date.now()}`,
    place,
    type,
    message,
    by: currentUser?.displayName || 'Guest',
    createdAt: new Date().toISOString(),
  });
  writeJsonArray(COMMUNITY_POSTS_KEY, posts);
  e.target.reset();
  renderCommunityPosts();
  showToast('Form post published.', 'success');
}

function renderCommunityPosts() {
  const root = document.getElementById('form-list');
  if (!root) return;
  const posts = readJsonArray(COMMUNITY_POSTS_KEY);
  root.innerHTML = posts.length ? '' : '<p class="panel-sub">No posts yet.</p>';
  posts.slice(0, 20).forEach(post => {
    const item = document.createElement('div');
    item.className = 'post-item';
    item.innerHTML = `
      <div class="post-meta"><span>${post.type.toUpperCase()}</span><span>${new Date(post.createdAt).toLocaleString()}</span></div>
      <h4>${post.place}</h4>
      <p>${post.message}</p>
      <p class="panel-sub">by ${post.by}</p>`;
    root.appendChild(item);
  });
}

function submitRealityFeed(e) {
  e.preventDefault();
  const place = document.getElementById('feed-place').value.trim();
  const videoUrl = document.getElementById('feed-video-url').value.trim();
  const note = document.getElementById('feed-note').value.trim();
  const feed = readJsonArray(REALITY_FEED_KEY);
  feed.unshift({
    id: `r_${Date.now()}`,
    place,
    videoUrl,
    note,
    by: currentUser?.displayName || 'Guest',
    createdAt: new Date().toISOString(),
  });
  writeJsonArray(REALITY_FEED_KEY, feed);
  e.target.reset();
  renderRealityFeed();
  showToast('Video experience added.', 'success');
}

function renderRealityFeed() {
  const root = document.getElementById('reality-feed-list');
  if (!root) return;
  const feed = readJsonArray(REALITY_FEED_KEY);
  root.innerHTML = feed.length ? '' : '<p class="panel-sub">No reality videos yet.</p>';
  feed.slice(0, 20).forEach(post => {
    const item = document.createElement('div');
    item.className = 'post-item';
    item.innerHTML = `
      <div class="post-meta"><span>${new Date(post.createdAt).toLocaleString()}</span><span>@${post.by}</span></div>
      <h4>${post.place}</h4>
      <p>${post.note}</p>
      <div class="product-actions"><a class="btn-mini" href="${post.videoUrl}" target="_blank" rel="noopener">Watch Video</a></div>`;
    root.appendChild(item);
  });
}

function submitCustomWorkRequest(e) {
  e.preventDefault();
  const title = document.getElementById('work-title').value.trim();
  const details = document.getElementById('work-details').value.trim();
  const contact = document.getElementById('work-contact').value.trim();
  const jobs = readJsonArray(CUSTOM_WORK_KEY);
  jobs.unshift({
    id: `w_${Date.now()}`,
    title,
    details,
    contact,
    by: currentUser?.displayName || 'Guest',
    createdAt: new Date().toISOString(),
  });
  writeJsonArray(CUSTOM_WORK_KEY, jobs);
  e.target.reset();
  renderCustomWorkRequests();
  showToast('Work request posted.', 'success');
}

function renderCustomWorkRequests() {
  const root = document.getElementById('work-request-list');
  if (!root) return;
  const jobs = readJsonArray(CUSTOM_WORK_KEY);
  root.innerHTML = jobs.length ? '' : '<p class="panel-sub">No custom work requests yet.</p>';
  jobs.slice(0, 20).forEach(job => {
    const item = document.createElement('div');
    item.className = 'post-item';
    item.innerHTML = `
      <div class="post-meta"><span>${new Date(job.createdAt).toLocaleString()}</span><span>@${job.by}</span></div>
      <h4>${job.title}</h4>
      <p>${job.details}</p>
      <p class="panel-sub">Contact: ${job.contact}</p>`;
    root.appendChild(item);
  });
}

function submitVacancy(e) {
  e.preventDefault();
  const role = document.getElementById('vacancy-role').value.trim();
  const business = document.getElementById('vacancy-business').value.trim();
  const details = document.getElementById('vacancy-details').value.trim();
  const jobs = readJsonArray(VACANCIES_KEY);
  jobs.unshift({
    id: `v_${Date.now()}`,
    role,
    business,
    details,
    createdAt: new Date().toISOString(),
  });
  writeJsonArray(VACANCIES_KEY, jobs);
  e.target.reset();
  renderVacancies();
  showToast('Vacancy posted.', 'success');
}

function applyVacancy(jobId) {
  showToast(`Application submitted for ${jobId}. Business will contact you.`, 'success', 2500);
}

function renderVacancies() {
  const root = document.getElementById('vacancy-list');
  if (!root) return;
  const jobs = readJsonArray(VACANCIES_KEY);
  root.innerHTML = jobs.length ? '' : '<p class="panel-sub">No vacancies yet.</p>';
  jobs.slice(0, 20).forEach(job => {
    const item = document.createElement('div');
    item.className = 'post-item';
    item.innerHTML = `
      <div class="post-meta"><span>${new Date(job.createdAt).toLocaleString()}</span><span>${job.business}</span></div>
      <h4>${job.role}</h4>
      <p>${job.details}</p>
      <button class="btn-mini" onclick="applyVacancy('${job.id}')">Apply</button>`;
    root.appendChild(item);
  });
}

function initHackathonDashboard() {
  renderPersonalizedMetrics();
  renderChatResults(PRODUCT_CATALOG.slice(0, 4));
  renderPersonalizedFilters();
  const saved = localStorage.getItem(personalFilterKey()) || getPreferredCategories()[0] || 'food';
  selectPersonalizedFilter(saved, null, false);
  renderCommunityPosts();
  renderRealityFeed();
  renderCustomWorkRequests();
  renderVacancies();
}

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

  const titles = {
    home: 'Home Dashboard',
    form: 'Community Form',
    feed: 'Reality Feed',
    request: 'Request Custom Work',
    vacancy: 'Vacancy Board',
  };
  const title = document.getElementById('dash-title');
  if (title) title.textContent = titles[page] || 'LocalPlaces';

  if (page === 'home') {
    renderPersonalizedMetrics();
  }
  if (page === 'form') renderCommunityPosts();
  if (page === 'feed') renderRealityFeed();
  if (page === 'request') renderCustomWorkRequests();
  if (page === 'vacancy') renderVacancies();
}

function updateHeaderPoints() {
  const pts = userData?.points || 0;
  document.getElementById('hdr-points').textContent = pts.toLocaleString();
}

/* ------------------------------------------------------------------
   13. SEED SAMPLE DATA
   ------------------------------------------------------------------ */
async function seedPlacesIfNeeded() {
  if (backendMode === 'local') return;
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
