
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
let activePlaceDashboardSession = null;

const LOCAL_USER_KEY_PREFIX = 'localplaces_user_';
const LOGIN_INFO_KEY = 'localplaces_login_info';
const AUTH_USERS_KEY = 'localplaces_auth_users';
const AUTH_SESSION_KEY = 'localplaces_auth_session';
const AUTH_BOOTSTRAP_FLAG_KEY = 'localplaces_auth_bootstrapped_v1';
const localAuthListeners = [];
let localAuthCurrentUser = null;
let authBootstrapPromise = null;

const firebaseConfig = {
  apiKey: 'AIzaSyCgsXlLIpJUVaIAqU5EsTXFrQ1IoT9QjeI',
  authDomain: 'local-places-7c480.firebaseapp.com',
  projectId: 'local-places-7c480',
  storageBucket: 'local-places-7c480.firebasestorage.app',
  messagingSenderId: '261258566211',
  appId: '1:261258566211:web:f0e807deba3793d2a592f6',
};

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

const localAuth = {
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

let auth = localAuth;

function initializeFirebaseAuthProvider() {
  const protocol = window.location?.protocol || '';
  if (protocol !== 'http:' && protocol !== 'https:') {
    return localAuth;
  }

  if (!window.firebase?.initializeApp || !window.firebase?.auth) {
    return localAuth;
  }

  try {
    const existingApp = window.firebase.apps?.length ? window.firebase.app() : window.firebase.initializeApp(firebaseConfig);
    const firebaseAuth = existingApp.auth();

    const withFallback = (action) => async (...args) => {
      try {
        return await action(...args);
      } catch (error) {
        const code = String(error?.code || '');
        if (
          code === 'auth/api-key-not-valid'
          || code === 'auth/app-not-authorized'
          || code === 'auth/unauthorized-domain'
          || code === 'auth/operation-not-allowed'
        ) {
          console.warn('Firebase auth rejected by project settings. Falling back to local auth.', code);
          auth = localAuth;
        }
        throw error;
      }
    };

    return {
      // We use popup-based Google auth; skip redirect result polling to avoid noisy startup network errors.
      getRedirectResult: async () => ({ user: null }),
      onAuthStateChanged: (callback) => firebaseAuth.onAuthStateChanged(callback),
      signInWithEmailAndPassword: withFallback((email, password) => firebaseAuth.signInWithEmailAndPassword(email, password)),
      createUserWithEmailAndPassword: withFallback((email, password) => firebaseAuth.createUserWithEmailAndPassword(email, password)),
      signInWithPopup: withFallback(() => {
        const provider = new window.firebase.auth.GoogleAuthProvider();
        return firebaseAuth.signInWithPopup(provider);
      }),
      signInWithRedirect: withFallback(() => {
        const provider = new window.firebase.auth.GoogleAuthProvider();
        return firebaseAuth.signInWithRedirect(provider);
      }),
      signInAnonymously: withFallback(() => firebaseAuth.signInAnonymously()),
      signOut: withFallback(() => firebaseAuth.signOut()),
    };
  } catch (error) {
    console.warn('Firebase auth init failed. Falling back to local auth.', error?.message || error);
    return localAuth;
  }
}

hydrateLocalAuthSession();
bootstrapAuthUsersFromTemplate();
auth = initializeFirebaseAuthProvider();

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
const BUSINESS_INSIGHTS_KEY = 'localplaces_business_insights';

const SCORE_WEIGHTS = {
  preference: 0.4,
  distance: 0.2,
  time: 0.2,
  popularity: 0.2,
};

const GOOGLE_MAPS_API_KEY = 'AIzaSyBkEJ3475FKjkUKEBdxvBJqEL4PLhY0nPk';
let mapsScriptLoadPromise = null;
let comparisonSearchQuery = '';

function ensureGoogleMapsLoaded() {
  if (window._mapsReady && window.google?.maps) {
    return Promise.resolve(true);
  }
  if (window._mapsError) {
    return Promise.resolve(false);
  }
  if (mapsScriptLoadPromise) {
    return mapsScriptLoadPromise;
  }

  mapsScriptLoadPromise = new Promise((resolve) => {
    window.initMapsCallback = function () {
      window._mapsReady = true;
      resolve(true);
      if (window._onMapsReady) window._onMapsReady();
    };

    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}&libraries=places&callback=initMapsCallback`;
    script.async = true;
    script.defer = true;
    script.onerror = function () {
      window._mapsError = true;
      resolve(false);
      if (window.handleMapsUnavailable) window.handleMapsUnavailable();
    };
    document.head.appendChild(script);
  });

  return mapsScriptLoadPromise;
}

const DISTANCE_FILTERS_KM = [3, 5, 10, 20];
let selectedDistanceFilterKm = 10;
const recommendationContextCache = new Map();

const API_BASE_URL = (window.LOCALPLACES_API_BASE || 'http://localhost:4000/api').replace(/\/$/, '');
const BACKEND_GUEST_KEY = 'localplaces_backend_guest_id';

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

const TRENDING_PRODUCT_PRICES = [
  { id: 'tp1', name: 'Wireless Earbuds', onlinePrice: 1980, localPrice: 2140, trendingRank: 1 },
  { id: 'tp2', name: 'Smart Watch', onlinePrice: 2299, localPrice: 2450, trendingRank: 2 },
  { id: 'tp3', name: 'Running Shoes', onlinePrice: 1899, localPrice: 1750, trendingRank: 3 },
  { id: 'tp4', name: 'Protein Powder 1kg', onlinePrice: 2099, localPrice: 1990, trendingRank: 4 },
  { id: 'tp5', name: 'Bluetooth Speaker', onlinePrice: 1299, localPrice: 1450, trendingRank: 5 },
  { id: 'tp6', name: 'Backpack 35L', onlinePrice: 999, localPrice: 1120, trendingRank: 6 },
  { id: 'tp7', name: 'Cricket Bat', onlinePrice: 1799, localPrice: 1690, trendingRank: 7 },
  { id: 'tp8', name: 'Football Studs', onlinePrice: 1490, localPrice: 1599, trendingRank: 8 },
  { id: 'tp9', name: 'Mixer Grinder', onlinePrice: 3299, localPrice: 3440, trendingRank: 9 },
  { id: 'tp10', name: 'LED Study Lamp', onlinePrice: 599, localPrice: 620, trendingRank: 10 },
];

const ONLINE_COMPARISON_SITES = [
  { id: 'amazon', name: 'Amazon', base: 'https://www.amazon.in/s?k=' },
  { id: 'flipkart', name: 'Flipkart', base: 'https://www.flipkart.com/search?q=' },
  { id: 'croma', name: 'Croma', base: 'https://www.croma.com/search/?text=' },
  { id: 'reliance', name: 'Reliance Digital', base: 'https://www.reliancedigital.in/search?q=' },
  { id: 'vijay', name: 'Vijay Sales', base: 'https://www.vijaysales.com/search/' },
  { id: 'tatacliq', name: 'Tata Cliq', base: 'https://www.tatacliq.com/search/?searchCategory=all&text=' },
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

function fmtInr(amount) {
  return `INR ${Number(amount || 0).toLocaleString('en-IN')}`;
}

function buildVerificationLinks(productName) {
  const q = encodeURIComponent(productName);
  return {
    amazon: `https://www.amazon.in/s?k=${q}`,
    flipkart: `https://www.flipkart.com/search?q=${q}`,
    other: `https://www.indiamart.com/search.mp?ss=${q}`,
    local: `https://www.google.com/maps/search/${q}+near+me`,
  };
}

function computeComparisonProductScore(item) {
  const total = Math.max(TRENDING_PRODUCT_PRICES.length - 1, 1);
  const preference = Math.max(0, 1 - ((item.trendingRank - 1) / total));
  const priceGap = Math.abs(Number(item.localPrice || 0) - Number(item.onlinePrice || 0));
  const baseline = Math.max(Number(item.onlinePrice || 1), Number(item.localPrice || 1), 1);
  const distance = Math.max(0, 1 - (priceGap / baseline));
  const time = ['Afternoon', 'Evening'].includes(getTimeBucket()) ? 1 : 0.7;
  const popularity = preference;

  return (
    preference * SCORE_WEIGHTS.preference +
    distance * SCORE_WEIGHTS.distance +
    time * SCORE_WEIGHTS.time +
    popularity * SCORE_WEIGHTS.popularity
  );
}

function computeQuerySeed(query) {
  return String(query || '').split('').reduce((sum, ch, idx) => sum + (ch.charCodeAt(0) * (idx + 3)), 0);
}

function buildSearchComparisonRows(query) {
  const clean = String(query || '').trim().replace(/\s+/g, ' ');
  if (!clean) return [];

  const encoded = encodeURIComponent(clean);
  const seed = computeQuerySeed(clean.toLowerCase());
  const mrp = 1200 + (seed % 4200);
  const localPrice = Math.max(299, Math.round((mrp * (0.98 + ((seed % 8) / 100))) / 10) * 10);

  return ONLINE_COMPARISON_SITES.map((site, idx) => {
    const offset = ((seed + idx * 37) % 18) - 9;
    const siteFactor = 0.84 + ((idx % 4) * 0.025);
    const onlinePrice = Math.max(249, Math.round(((mrp * siteFactor) + offset * 15) / 10) * 10);
    const savedVsLocal = localPrice - onlinePrice;
    const savedVsMrp = Math.max(0, mrp - onlinePrice);
    const score = Math.max(0, Math.min(1, 1 - Math.abs(localPrice - onlinePrice) / Math.max(localPrice, 1)));

    return {
      id: `${site.id}_${idx}`,
      name: clean,
      platform: site.name,
      trendingRank: idx + 1,
      onlinePrice,
      localPrice,
      diff: savedVsLocal,
      savedVsMrp,
      score,
      link: `${site.base}${encoded}`,
    };
  }).sort((a, b) => a.onlinePrice - b.onlinePrice);
}

function normalizeComparisonQuery(query) {
  return String(query || '')
    .replace(/headphons/gi, 'headphones')
    .replace(/earbuds?/gi, 'earbuds')
    .trim();
}

function ensureComparisonSearchUi() {
  const page = document.getElementById('comparization-page');
  if (!page) return;

  const panel = page.querySelector('.panel-card');
  if (!panel) return;

  let form = document.querySelector('.comparison-search-row');
  if (!form) {
    const kpiRow = document.getElementById('comparization-kpi-row');
    const searchWrap = document.createElement('form');
    searchWrap.className = 'comparison-search-row';
    searchWrap.innerHTML = `
      <input id="comparison-search-input" type="text" placeholder="Search product (example: Boat Headphones, iPhone 15, Cricket Bat)" />
      <button class="btn-primary" type="submit">Compare Prices</button>
      <button class="btn-ghost" type="button" id="comparison-clear-btn">Clear</button>
    `;

    if (kpiRow?.parentNode) {
      kpiRow.parentNode.insertBefore(searchWrap, kpiRow);
    } else {
      panel.appendChild(searchWrap);
    }
    form = searchWrap;
  }

  if (!document.getElementById('comparison-search-hint')) {
    const hint = document.createElement('p');
    hint.id = 'comparison-search-hint';
    hint.className = 'panel-sub';
    hint.textContent = 'Search a product to compare prices across multiple online websites with links and savings.';
    const kpiRow = document.getElementById('comparization-kpi-row');
    if (kpiRow?.parentNode) {
      kpiRow.parentNode.insertBefore(hint, kpiRow);
    } else {
      panel.appendChild(hint);
    }
  }

  const tableBody = document.getElementById('product-comparison-list');
  if (!tableBody) {
    const table = page.querySelector('.comparison-table');
    const tbody = document.createElement('tbody');
    tbody.id = 'product-comparison-list';
    if (table) table.appendChild(tbody);
  }
}

function bindComparisonSearchEvents() {
  const form = document.querySelector('.comparison-search-row');
  const input = document.getElementById('comparison-search-input');
  const clearBtn = document.getElementById('comparison-clear-btn')
    || document.querySelector('.comparison-search-row .btn-ghost[type="button"]');
  if (!form || !input) return;

  if (!form.dataset.boundComparisonSubmit) {
    form.addEventListener('submit', handleComparisonSearch);
    form.dataset.boundComparisonSubmit = '1';
  }

  if (!input.dataset.boundComparisonInput) {
    input.addEventListener('input', () => {
      comparisonSearchQuery = normalizeComparisonQuery(input.value);
      renderProductComparization();
    });
    input.dataset.boundComparisonInput = '1';
  }

  if (clearBtn && !clearBtn.dataset.boundComparisonClear) {
    clearBtn.addEventListener('click', clearComparisonSearch);
    clearBtn.dataset.boundComparisonClear = '1';
  }
}

function handleComparisonSearch(e) {
  if (e?.preventDefault) e.preventDefault();
  const input = document.getElementById('comparison-search-input');
  comparisonSearchQuery = normalizeComparisonQuery(input?.value || '');
  renderProductComparization();
}

function clearComparisonSearch() {
  comparisonSearchQuery = '';
  const input = document.getElementById('comparison-search-input');
  if (input) input.value = '';
  renderProductComparization();
}

function getBackendUserId() {
  if (currentUser?.uid) return currentUser.uid;
  let guestId = localStorage.getItem(BACKEND_GUEST_KEY);
  if (!guestId) {
    guestId = `guest_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    localStorage.setItem(BACKEND_GUEST_KEY, guestId);
  }
  return guestId;
}

async function backendPost(path, payload) {
  try {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (error) {
    console.warn(`Backend request failed for ${path}`, error.message || error);
    return null;
  }
}

function toScorablePlace(place, category) {
  const lat = place?.geometry?.location?.lat ? place.geometry.location.lat() : null;
  const lng = place?.geometry?.location?.lng ? place.geometry.location.lng() : null;
  const sourceCategory = place?._sourceCategory || category;
  const tags = [...new Set([sourceCategory, ...(place?.types || [])].filter(Boolean))];
  return {
    placeId: place?.place_id,
    name: place?.name || 'Unknown',
    category: sourceCategory,
    tags,
    location: (lat !== null && lng !== null) ? { lat, lng } : null,
    rating: Number(place?.rating || 0),
    reviewCount: Number(place?.user_ratings_total || 0),
  };
}

function placeMatchesSelectedTag(place, selectedCategory) {
  if (!selectedCategory) return true;
  const source = place?._sourceCategory;
  if (source === selectedCategory) return true;

  const tagCandidates = new Set([...(place?.types || []), ...(getPlaceTagsForCard(place, source || selectedCategory) || [])]
    .map(tag => String(tag || '').toLowerCase()));

  const selectedCfg = CATEGORY_SEARCH_CONFIG[selectedCategory];
  const selectedTokens = new Set([
    selectedCategory,
    selectedCfg?.type,
    ...(selectedCfg?.keyword ? selectedCfg.keyword.split(' ') : []),
  ].filter(Boolean).map(x => String(x).toLowerCase()));

  for (const token of selectedTokens) {
    if (tagCandidates.has(token)) return true;
  }
  return false;
}

async function trackTagClickBackend(tag, placeId) {
  backendPost('/interactions/click', {
    userId: getBackendUserId(),
    tag,
    placeId,
    source: 'dashboard',
  });
}

async function trackDashboardTimeBackend(tag, placeId, durationSec) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return;
  backendPost('/interactions/time', {
    userId: getBackendUserId(),
    tag,
    placeId,
    durationSec,
    source: 'place-dashboard',
  });
}

async function trackImpressionsBackend(items, selectedTag) {
  if (!Array.isArray(items) || !items.length) return;
  const payloadItems = items.map(item => {
    const place = item.place || item;
    return {
      placeId: place?.place_id,
      name: place?.name,
      rating: Number(place?.rating || 0),
      reviewCount: Number(place?.user_ratings_total || 0),
      category: place?._sourceCategory || selectedTag,
    };
  }).filter(x => x.placeId);

  if (!payloadItems.length) return;
  backendPost('/interactions/impression', {
    userId: getBackendUserId(),
    selectedTag,
    items: payloadItems,
  });
}

async function rankPlacesViaBackend(places, selectedCategory, center) {
  const payloadPlaces = (places || []).map(place => toScorablePlace(place, selectedCategory)).filter(p => p.placeId);
  if (!payloadPlaces.length) return null;

  const response = await backendPost('/recommendations/rank', {
    userId: getBackendUserId(),
    selectedTag: selectedCategory,
    currentLocation: center,
    weights: SCORE_WEIGHTS,
    places: payloadPlaces,
  });

  if (!response || !Array.isArray(response.ranked)) return null;
  const rankMap = new Map(response.ranked.map(item => [item.placeId, item]));
  return rankMap;
}

function getCurrentHour() {
  return new Date().getHours();
}

function getTimeBucket(hour = getCurrentHour()) {
  if (hour >= 5 && hour < 11) return 'Morning';
  if (hour >= 11 && hour < 16) return 'Afternoon';
  if (hour >= 16 && hour < 21) return 'Evening';
  return 'Night';
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function readBusinessInsightsStore() {
  try {
    const raw = localStorage.getItem(BUSINESS_INSIGHTS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || parsed.date !== todayKey()) {
      return { date: todayKey(), shops: {}, hourlyTotals: {} };
    }
    return {
      date: parsed.date,
      shops: parsed.shops || {},
      hourlyTotals: parsed.hourlyTotals || {}
    };
  } catch {
    return { date: todayKey(), shops: {}, hourlyTotals: {} };
  }
}

function saveBusinessInsightsStore(store) {
  localStorage.setItem(BUSINESS_INSIGHTS_KEY, JSON.stringify(store));
}

function getCategoryAffinityScore(category) {
  const analytics = getAnalytics();
  const categoryCounts = analytics.categoryCounts || {};
  const maxCount = Math.max(1, ...Object.values(categoryCounts), 1);
  const behaviorScore = Math.min(1, (categoryCounts[category] || 0) / maxCount);

  const isInterestMatch = (userData?.interests || []).includes(category);
  const interestBoost = isInterestMatch ? 1 : 0;

  return Math.min(1, behaviorScore * 0.7 + interestBoost * 0.3);
}

function getDistanceScore(distanceKm, maxDistanceKm = selectedDistanceFilterKm) {
  if (distanceKm === null || distanceKm === undefined || !Number.isFinite(distanceKm)) return 0.3;
  const clamped = Math.min(distanceKm, maxDistanceKm);
  return Math.max(0, 1 - clamped / Math.max(maxDistanceKm, 0.1));
}

function getTimeRelevanceScore(category, hour = getCurrentHour()) {
  const bucket = getTimeBucket(hour);
  const preferred = {
    food: ['Afternoon', 'Evening', 'Night'],
    shopping: ['Afternoon', 'Evening'],
    fitness: ['Morning', 'Evening'],
    football: ['Evening', 'Night'],
    cricket: ['Morning', 'Evening'],
    walking: ['Morning', 'Evening'],
    nature: ['Morning', 'Afternoon'],
    history: ['Morning', 'Afternoon'],
    art: ['Afternoon', 'Evening'],
    music: ['Evening', 'Night'],
  };
  const windows = preferred[category] || ['Afternoon', 'Evening'];
  return windows.includes(bucket) ? 1 : 0.45;
}

function getPopularityScore(place) {
  const rating = Number(place?.rating || 0);
  const ratingScore = Math.min(1, rating / 5);
  const reviews = Number(place?.user_ratings_total || place?.reviewCount || 0);
  const reviewScore = Math.min(1, Math.log10(reviews + 1) / 4);
  return ratingScore * 0.65 + reviewScore * 0.35;
}

function buildRecommendationExplanation(components, category, distanceKm) {
  const reasons = [];
  if (components.preference >= 0.6) reasons.push(`you often interact with ${CATEGORY_SEARCH_CONFIG[category]?.label || category}`);
  if (distanceKm !== null && distanceKm <= 2.5) reasons.push('it is nearby');
  if (components.time >= 0.8) reasons.push(`it matches ${getTimeBucket().toLowerCase()} demand`);
  if (components.popularity >= 0.7) reasons.push('it is trending now');

  if (!reasons.length && distanceKm !== null) reasons.push('it is close to your selected area');
  if (!reasons.length) reasons.push('it matches your current preferences');

  return `Recommended because ${reasons.join(' + ')}`;
}

function computeWeightedRecommendation(place, category, center, maxDistanceKm = selectedDistanceFilterKm) {
  const distanceKm = center?.lat && center?.lng && place?.geometry?.location
    ? haversineKm(center.lat, center.lng, place.geometry.location.lat(), place.geometry.location.lng())
    : null;

  const components = {
    preference: getCategoryAffinityScore(category),
    distance: getDistanceScore(distanceKm, maxDistanceKm),
    time: getTimeRelevanceScore(category),
    popularity: getPopularityScore(place),
  };

  const finalScore =
    components.preference * SCORE_WEIGHTS.preference +
    components.distance * SCORE_WEIGHTS.distance +
    components.time * SCORE_WEIGHTS.time +
    components.popularity * SCORE_WEIGHTS.popularity;

  return {
    finalScore,
    components,
    distanceKm,
    explanation: buildRecommendationExplanation(components, category, distanceKm),
  };
}

function trackBusinessRecommendationImpressions(recommendations) {
  if (!Array.isArray(recommendations) || !recommendations.length) return;
  const store = readBusinessInsightsStore();
  const hour = String(getCurrentHour());
  store.hourlyTotals[hour] = (store.hourlyTotals[hour] || 0) + recommendations.length;

  recommendations.forEach(item => {
    const placeId = item?.place?.place_id;
    if (!placeId) return;
    if (!store.shops[placeId]) {
      store.shops[placeId] = {
        name: item.place.name || 'Unknown Shop',
        appearances: 0,
        hourly: {}
      };
    }
    store.shops[placeId].appearances += 1;
    store.shops[placeId].hourly[hour] = (store.shops[placeId].hourly[hour] || 0) + 1;
  });

  saveBusinessInsightsStore(store);
  renderBusinessInsights();
}

function renderBusinessInsights() {
  const appearEl = document.getElementById('biz-appear-count');
  const peakEl = document.getElementById('biz-peak-traffic');
  const topShopEl = document.getElementById('biz-top-shop');
  if (!appearEl || !peakEl || !topShopEl) return;

  const store = readBusinessInsightsStore();
  const topShopEntry = Object.entries(store.shops || {})
    .sort((a, b) => (b[1]?.appearances || 0) - (a[1]?.appearances || 0))[0];

  const topShop = topShopEntry?.[1] || null;
  appearEl.textContent = String(topShop?.appearances || 0);
  topShopEl.textContent = topShop?.name || 'No data yet';

  const peakHour = Object.entries(store.hourlyTotals || {})
    .sort((a, b) => Number(b[1]) - Number(a[1]))[0]?.[0];
  peakEl.textContent = peakHour !== undefined ? getTimeBucket(Number(peakHour)) : '-';
}

function renderDistanceFilterControls() {
  const root = document.getElementById('distance-filter-controls');
  if (!root) return;

  root.innerHTML = '';
  DISTANCE_FILTERS_KM.forEach(km => {
    const btn = document.createElement('button');
    btn.className = `fchip ${selectedDistanceFilterKm === km ? 'active-chip' : ''}`;
    btn.type = 'button';
    btn.textContent = `${km} km`;
    btn.onclick = () => {
      selectedDistanceFilterKm = km;
      renderDistanceFilterControls();
      const savedCategory = localStorage.getItem(personalFilterKey()) || getPreferredCategories()[0] || 'food';
      loadNearbyPlacesByCategory(savedCategory);
    };
    root.appendChild(btn);
  });
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
  document.getElementById('settings-lat').value = Number.isFinite(userData?.location?.lat) ? userData.location.lat : '';
  document.getElementById('settings-lng').value = Number.isFinite(userData?.location?.lng) ? userData.location.lng : '';
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

function detectSettingsLocation() {
  const latEl = document.getElementById('settings-lat');
  const lngEl = document.getElementById('settings-lng');
  if (!latEl || !lngEl) return;

  if (!navigator.geolocation) {
    showToast('Geolocation not available on this device.', 'error');
    return;
  }

  navigator.geolocation.getCurrentPosition(
    pos => {
      latEl.value = pos.coords.latitude.toFixed(6);
      lngEl.value = pos.coords.longitude.toFixed(6);
      showToast('Current location added.', 'success');
    },
    () => {
      showToast('Could not fetch current location. Enter coordinates manually.', 'error');
    }
  );
}

function saveProfileSettings(e) {
  e.preventDefault();
  const nextName = document.getElementById('settings-name').value.trim();
  const nextEmail = document.getElementById('settings-email').value.trim().toLowerCase();
  const latInput = document.getElementById('settings-lat').value.trim();
  const lngInput = document.getElementById('settings-lng').value.trim();

  if (!nextName || !nextEmail) {
    showToast('Name and email are required.', 'error');
    return;
  }

  const hasLat = latInput.length > 0;
  const hasLng = lngInput.length > 0;
  if (hasLat !== hasLng) {
    showToast('Enter both latitude and longitude.', 'error');
    return;
  }

  let nextLocation = userData?.location || null;
  if (hasLat && hasLng) {
    const lat = Number(latInput);
    const lng = Number(lngInput);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      showToast('Latitude must be -90 to 90 and longitude -180 to 180.', 'error');
      return;
    }
    nextLocation = { lat, lng };
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
    userData.location = nextLocation;
    if (currentUser?.uid) saveLocalUserData(currentUser.uid, userData);
  }

  userLocation = nextLocation;
  if (currentUser?.uid) {
    setOneTimePersonalizationForCurrentUser(userData?.interests || [], nextLocation);
  }

  trackLoginInfo(currentUser);
  updateSidebarProfile();
  closeSettingsModal();
  showToast('Profile settings updated.', 'success');

  if (!document.getElementById('app-view')?.classList.contains('hidden')) {
    loadFeed();
  }
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
  try {
    await auth.signInWithPopup();
  } catch (err) {
    showToast(friendlyAuthError(err?.code || 'auth/operation-not-allowed'), 'error');
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
  ensureGoogleMapsLoaded();

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
  ensureGoogleMapsLoaded();

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
  const prefRaw = (place.tags || []).reduce((sum, t) => sum + (tagScores[t] || 0), 0);
  const prefNorm = Math.min(1, prefRaw / 10);
  const distKm = (uLat && uLng) ? haversineKm(uLat, uLng, place.location.lat, place.location.lng) : null;
  const distanceNorm = getDistanceScore(distKm, selectedDistanceFilterKm);
  const timeNorm = getTimeRelevanceScore((place.tags || [])[0] || 'food');
  const popularityNorm = getPopularityScore(place);

  return (
    prefNorm * SCORE_WEIGHTS.preference +
    distanceNorm * SCORE_WEIGHTS.distance +
    timeNorm * SCORE_WEIGHTS.time +
    popularityNorm * SCORE_WEIGHTS.popularity
  );
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
  finalizeActivePlaceDashboardSession();

  const modal = document.getElementById('place-modal');
  const body = document.getElementById('place-modal-body');
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  const complaintWarningHtml = renderComplaintWarningHtml(place.name);

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
    </div>
    ${complaintWarningHtml}`;

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

  const primaryCategory = (place.tags || []).find(tag => CATEGORY_SEARCH_CONFIG[tag])
    || (place.tags || [])[0]
    || 'food';
  const placeId = place.id || place.placeId || place.name;
  bumpProductMetric('view', primaryCategory);
  trackTagClickBackend(primaryCategory, placeId);
  activePlaceDashboardSession = {
    placeId,
    category: primaryCategory,
    startedAt: Date.now(),
  };
}

function closePlaceModal(e) {
  if (e && e.target !== document.getElementById('place-modal') && !e.target.classList.contains('modal-close-btn')) return;

  finalizeActivePlaceDashboardSession();

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

function normalizePlaceNameForMatch(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(restaurant|restro|resto|restront|cafe|hotel|bar|shop|store|mall)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getComplaintWarningsForPlace(placeName) {
  const normalizedTarget = normalizePlaceNameForMatch(placeName);
  if (!normalizedTarget) return [];

  return readJsonArray(COMMUNITY_POSTS_KEY)
    .filter(post => String(post?.type || '').toLowerCase() === 'complaint')
    .filter(post => {
      const normalizedPostPlace = normalizePlaceNameForMatch(post?.place);
      if (!normalizedPostPlace) return false;
      return normalizedPostPlace === normalizedTarget
        || normalizedPostPlace.includes(normalizedTarget)
        || normalizedTarget.includes(normalizedPostPlace);
    })
    .slice(0, 3);
}

function renderComplaintWarningHtml(placeName) {
  const matches = getComplaintWarningsForPlace(placeName);
  if (!matches.length) {
    return '<div class="review-warning-clear"><i class="fas fa-shield-check"></i> No complaint warnings from Community Form.</div>';
  }

  const items = matches.map(post => `
    <div class="review-warning-item">
      <div class="review-warning-head">
        <strong>Warning</strong>
        <span>${new Date(post.createdAt).toLocaleString()}</span>
      </div>
      <p>${post.message || 'Complaint reported by community users.'}</p>
    </div>
  `).join('');

  return `
    <div class="review-warning-wrap">
      <h4><i class="fas fa-triangle-exclamation"></i> Review Warnings</h4>
      <p class="panel-sub">Matched complaint entries for this restaurant from Community Form.</p>
      ${items}
    </div>
  `;
}

function getAnalytics() {
  const uid = currentUser?.uid || 'guest';
  try {
    const raw = localStorage.getItem(analyticsKey(uid));
    if (!raw) return { views: 0, purchases: 0, categoryCounts: {}, tagTimeSpentSec: {} };
    const parsed = JSON.parse(raw);
    return {
      views: parsed.views || 0,
      purchases: parsed.purchases || 0,
      categoryCounts: parsed.categoryCounts || {},
      tagTimeSpentSec: parsed.tagTimeSpentSec || {}
    };
  } catch {
    return { views: 0, purchases: 0, categoryCounts: {}, tagTimeSpentSec: {} };
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

function bumpDashboardTimeMetric(category, durationSec) {
  if (!category || !Number.isFinite(durationSec) || durationSec <= 0) return;
  const analytics = getAnalytics();
  analytics.tagTimeSpentSec = analytics.tagTimeSpentSec || {};
  analytics.tagTimeSpentSec[category] = (analytics.tagTimeSpentSec[category] || 0) + durationSec;
  saveAnalytics(analytics);
}

function finalizeActivePlaceDashboardSession() {
  if (!activePlaceDashboardSession) return;

  const durationSec = Math.max(1, Math.round((Date.now() - activePlaceDashboardSession.startedAt) / 1000));
  const { category, placeId } = activePlaceDashboardSession;

  trackDashboardTimeBackend(category, placeId, durationSec);
  bumpDashboardTimeMetric(category, durationSec);

  const context = recommendationContextCache.get(placeId);
  if (context) {
    context.rawMetrics = context.rawMetrics || {};
    context.rawMetrics.timeSpentSec = Number(context.rawMetrics.timeSpentSec || 0) + durationSec;
  }

  activePlaceDashboardSession = null;
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
      <div class="product-score"><i class="fas fa-chart-line"></i> Score ${Number(item.score || 0).toFixed(1)}</div>
      <p>${item.site} • ${item.price} • ${item.category}</p>
      <div class="product-actions">
        <button class="btn-mini" onclick="trackProductView('${item.id}')">View</button>
        <a class="btn-mini" href="${item.url}" target="_blank" rel="noopener" onclick="trackProductPurchase('${item.id}')">Open Dashboard</a>
      </div>`;
    root.appendChild(card);
  });
}

function textSearchPromise(request) {
  return new Promise((resolve, reject) => {
    const map = getPlacesService();
    if (!map) {
      reject(new Error('Google Maps unavailable'));
      return;
    }
    const service = new google.maps.places.PlacesService(map);
    service.textSearch(request, (results, status) => {
      if (status === google.maps.places.PlacesServiceStatus.OK || status === google.maps.places.PlacesServiceStatus.ZERO_RESULTS) {
        resolve(results || []);
      } else {
        reject(new Error(status));
      }
    });
  });
}

async function searchMapPlacesFromChatQuery(query, center) {
  if (!window.google || !google.maps || !google.maps.places || window._mapsError) {
    throw new Error('Google Maps unavailable');
  }

  const request = {
    query,
    location: new google.maps.LatLng(center.lat, center.lng),
    radius: 10000,
  };

  const results = await textSearchPromise(request);
  const deduped = [];
  const seen = new Set();
  results.forEach(place => {
    if (!place?.place_id || seen.has(place.place_id)) return;
    seen.add(place.place_id);
    deduped.push(place);
  });

  deduped.sort((a, b) => {
    const aLat = a.geometry?.location?.lat?.();
    const aLng = a.geometry?.location?.lng?.();
    const bLat = b.geometry?.location?.lat?.();
    const bLng = b.geometry?.location?.lng?.();
    const aDist = (Number.isFinite(aLat) && Number.isFinite(aLng)) ? haversineKm(center.lat, center.lng, aLat, aLng) : Number.POSITIVE_INFINITY;
    const bDist = (Number.isFinite(bLat) && Number.isFinite(bLng)) ? haversineKm(center.lat, center.lng, bLat, bLng) : Number.POSITIVE_INFINITY;
    if (aDist !== bDist) return aDist - bDist;
    return (b.rating || 0) - (a.rating || 0);
  });

  return deduped.slice(0, 24);
}

function renderMapChatResults(places, center) {
  const section = document.getElementById('map-chat-section');
  const grid = document.getElementById('map-chat-results');
  const empty = document.getElementById('map-chat-empty');
  if (!section || !grid || !empty) return;

  section.classList.remove('hidden');
  grid.innerHTML = '';

  if (!places.length) {
    empty.classList.remove('hidden');
    return;
  }

  empty.classList.add('hidden');
  places.forEach(place => {
    const lat = place.geometry?.location?.lat?.();
    const lng = place.geometry?.location?.lng?.();
    const distKm = (Number.isFinite(lat) && Number.isFinite(lng))
      ? haversineKm(center.lat, center.lng, lat, lng)
      : null;

    nearbyPlaceCache.set(place.place_id, place);

    const card = document.createElement('div');
    card.className = 'map-result-card';
    card.innerHTML = `
      <h4>${place.name}</h4>
      <p>${place.formatted_address || place.vicinity || 'Nearby area'}</p>
      <p>${distKm !== null ? `${fmtDist(distKm)} away` : 'Distance unavailable'} • ⭐ ${(place.rating || 0).toFixed(1)}</p>
      <div class="product-actions">
        <button class="btn-mini" onclick="openNearbyPlaceDashboard('${place.place_id}','food')">Open Dashboard</button>
      </div>`;
    grid.appendChild(card);
  });
}

async function runMapChatSearch(query) {
  const section = document.getElementById('map-chat-section');
  const loading = document.getElementById('map-chat-loading');
  const empty = document.getElementById('map-chat-empty');
  const hint = document.getElementById('map-chat-hint');
  const grid = document.getElementById('map-chat-results');
  if (!section || !loading || !empty || !hint || !grid) return;

  section.classList.remove('hidden');
  loading.classList.remove('hidden');
  empty.classList.add('hidden');
  grid.innerHTML = '';
  hint.textContent = `Google Maps results for "${query}" near your location.`;

  const center = userData?.location || { lat: 22.7196, lng: 75.8577 };
  try {
    const places = await searchMapPlacesFromChatQuery(query, center);
    renderMapChatResults(places, center);
    if (!places.length) {
      empty.classList.remove('hidden');
      hint.textContent = 'No nearby places matched this query. Try a different phrase.';
    }
  } catch {
    empty.classList.remove('hidden');
    empty.textContent = 'Google Maps is unavailable. Enable maps and location to run chatbot search.';
    hint.textContent = 'Maps search needs map access.';
  } finally {
    loading.classList.add('hidden');
  }
}

async function handleProductChat(e) {
  e.preventDefault();
  const query = document.getElementById('chat-query').value.trim();
  const chatResults = document.getElementById('chat-results');
  if (chatResults) {
    chatResults.innerHTML = '<p class="panel-sub">Searching Google Maps with your query...</p>';
  }

  await runMapChatSearch(query);
  if (chatResults) {
    chatResults.innerHTML = '';
  }
  showToast('Maps search completed.', 'success', 1800);
}

function trackProductView(productId) {
  const item = PRODUCT_CATALOG.find(p => p.id === productId);
  bumpProductMetric('view', item?.category);
  if (item?.category) trackTagClickBackend(item.category, productId);
  if (item?.category) selectPersonalizedFilter(item.category);
}

function trackProductPurchase(productId) {
  const item = PRODUCT_CATALOG.find(p => p.id === productId);
  bumpProductMetric('purchase', item?.category);
  if (item?.category) trackTagClickBackend(item.category, productId);
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
  if (trackInteraction) {
    bumpProductMetric('view', category);
    trackTagClickBackend(category, null);
  }
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
    otherSection.classList.add('hidden');
    otherGrid.innerHTML = '';
    otherLoading.classList.add('hidden');
    otherEmpty.classList.add('hidden');
  }

  const cfg = CATEGORY_SEARCH_CONFIG[category] || CATEGORY_SEARCH_CONFIG.food;
  if (hint) {
    hint.textContent = `Showing ${cfg.label} for ${getTimeBucket().toLowerCase()} intent within ${selectedDistanceFilterKm} km.`;
  }

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
    const primaryResults = await searchNearbyByCategory(category, center, { radius: 9000, openNow: false });
    primaryResults.forEach(place => {
      place._sourceCategory = category;
      nearbyPlaceCache.set(place.place_id, place);
    });

    const selectedIds = new Set(primaryResults.map(place => place.place_id));
    const otherResults = await loadOtherOpenPlaces(category, [...selectedIds], { render: false });

    const merged = [];
    const seen = new Set();
    [...primaryResults, ...(otherResults || [])].forEach(place => {
      if (!place?.place_id || seen.has(place.place_id)) return;
      seen.add(place.place_id);
      merged.push(place);
    });

    const tagFiltered = merged.filter(place => placeMatchesSelectedTag(place, category));
    const candidatePlaces = tagFiltered.length ? tagFiltered : merged;

    const backendRankMap = await rankPlacesViaBackend(candidatePlaces, category, center);
    const ranked = candidatePlaces.map(place => {
      const backendRank = backendRankMap?.get(place.place_id);
      const fallback = computeWeightedRecommendation(place, category, center, selectedDistanceFilterKm);

      return {
        place,
        finalScore: Number(backendRank?.score ?? fallback.finalScore),
        components: backendRank?.components || fallback.components,
        rawMetrics: backendRank?.rawMetrics || null,
        distanceKm: Number.isFinite(backendRank?.distanceKm) ? backendRank.distanceKm : fallback.distanceKm,
        explanation: backendRank?.explanation || fallback.explanation,
      };
    }).filter(item => item.distanceKm === null || item.distanceKm <= selectedDistanceFilterKm);

    ranked.sort((a, b) => b.finalScore - a.finalScore);
    const topRecommendations = ranked.slice(0, 24);

    loading.classList.add('hidden');
    renderNearbyPlaces(topRecommendations, category);
    trackBusinessRecommendationImpressions(topRecommendations);
    trackImpressionsBackend(topRecommendations, category);
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

function renderNearbyPlaces(recommendations, category) {
  const grid = document.getElementById('feed-grid');
  const empty = document.getElementById('feed-empty');
  if (!grid || !empty) return;

  if (!recommendations?.length) {
    empty.classList.remove('hidden');
    empty.querySelector('p').textContent = `No places found within ${selectedDistanceFilterKm} km. Try a larger distance.`;
    return [];
  }

  empty.classList.add('hidden');
  grid.innerHTML = '';
  recommendationContextCache.clear();
  recommendations.forEach(item => {
    const place = item.place;
    const scoreLabel = Number(item.finalScore || 0) * 100;
    const openNow = place.opening_hours?.open_now;
    const statusText = openNow === true ? 'Open now' : openNow === false ? 'Closed now' : 'Status unknown';
    const placeCategory = place._sourceCategory || category;
    const tags = getPlaceTagsForCard(place, placeCategory);
    recommendationContextCache.set(place.place_id, item);
    const card = document.createElement('div');
    card.className = 'feed-card';
    card.innerHTML = `
      <img class="feed-card-img" src="${getPhotoUrl(place)}" alt="${place.name}" loading="lazy" />
      <div class="feed-card-body">
        <div class="feed-card-name">${place.name}</div>
        <div class="feed-card-desc">${place.vicinity || 'Nearby place'}</div>
        <div class="panel-sub">${item.explanation}</div>
        <button type="button" class="feed-score feed-score-btn" onclick="openScoreModal('${place.place_id}','${placeCategory}')"><i class="fas fa-chart-line"></i> Score ${scoreLabel.toFixed(1)}</button>
        <div class="feed-card-meta">
          <span class="feed-rating"><i class="fas fa-star"></i> ${(place.rating || 0).toFixed(1)}</span>
          <span class="feed-distance"><i class="fas fa-location-dot"></i> ${item.distanceKm !== null ? fmtDist(item.distanceKm) : 'Nearby'}</span>
          <span class="feed-distance"><i class="fas fa-store"></i> ${statusText}</span>
        </div>
        <div class="feed-tags">
          ${tags.map(tag => `<span class="tag-pill">${tag}</span>`).join('')}
        </div>
        <div class="product-actions" style="margin-top:8px;">
          <button class="btn-mini" onclick="openNearbyPlaceDashboard('${place.place_id}','${placeCategory}')">Open Dashboard</button>
        </div>
      </div>`;
    grid.appendChild(card);
  });

  return recommendations.map(item => item.place.place_id);
}

async function loadOtherOpenPlaces(selectedCategory, selectedPlaceIds = [], options = {}) {
  const otherSection = document.getElementById('other-open-section');
  const otherGrid = document.getElementById('other-open-grid');
  const otherLoading = document.getElementById('other-open-loading');
  const otherEmpty = document.getElementById('other-open-empty');
  const shouldRender = options.render !== false;
  if (!otherSection || !otherGrid || !otherLoading || !otherEmpty) return [];

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
    if (shouldRender) renderOtherOpenPlaces(deduped);
    return deduped;
  } finally {
    if (shouldRender) otherLoading.classList.add('hidden');
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
  const context = recommendationContextCache.get(placeId);

  finalizeActivePlaceDashboardSession();
  bumpProductMetric('view', category);

  trackTagClickBackend(category, placeId);
  activePlaceDashboardSession = {
    placeId,
    category,
    startedAt: Date.now(),
  };

  if (context) {
    context.rawMetrics = context.rawMetrics || {};
    const analytics = getAnalytics();
    context.rawMetrics.preferenceClicks = Number(analytics.categoryCounts?.[category] || 0);
  }

  let detail = base;
  try {
    detail = await placeDetailsPromise(placeId);
  } catch (e) {
    console.warn('Place details fallback', e);
  }

  const modal = document.getElementById('place-modal');
  const body = document.getElementById('place-modal-body');
  if (!modal || !body) return;
  const complaintWarningHtml = renderComplaintWarningHtml(detail.name || base.name);

  const lat = detail.geometry?.location?.lat ? detail.geometry.location.lat() : null;
  const lng = detail.geometry?.location?.lng ? detail.geometry.location.lng() : null;
  const directionsUrl = lat !== null && lng !== null
    ? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(detail.name)}`;

  body.innerHTML = `
    <img class="modal-place-img" src="${getPhotoUrl(detail)}" alt="${detail.name}" />
    <h2 class="modal-place-name">${detail.name}</h2>
    <p class="modal-place-addr"><i class="fas fa-location-dot"></i>${detail.formatted_address || base.vicinity || 'Nearby area'}</p>
    <p class="modal-place-desc">${context?.explanation || `Top match for your ${category} preference.`}</p>
    <div class="modal-meta-row">
      <span class="modal-badge badge-rating"><i class="fas fa-star"></i> ${(detail.rating || 0).toFixed(1)} / 5</span>
      ${context?.distanceKm !== null && context?.distanceKm !== undefined ? `<span class="modal-badge badge-dist"><i class="fas fa-person-walking"></i> ${fmtDist(context.distanceKm)} away</span>` : ''}
      <span class="modal-badge badge-reviews"><i class="fas fa-phone"></i> ${detail.formatted_phone_number || 'Contact unavailable'}</span>
    </div>
    <div class="product-actions" style="margin-top:12px;">
      <a class="btn-mini" href="${directionsUrl}" target="_blank" rel="noopener">Get Directions</a>
      ${detail.website ? `<a class="btn-mini" href="${detail.website}" target="_blank" rel="noopener">Website</a>` : ''}
    </div>
    ${complaintWarningHtml}`;

  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function openScoreModal(placeId, category) {
  const item = recommendationContextCache.get(placeId);
  if (!item) return;

  const modal = document.getElementById('score-modal');
  const placeText = document.getElementById('score-modal-place');
  const list = document.getElementById('score-breakdown-list');
  if (!modal || !placeText || !list) return;

  const placeName = item.place?.name || 'Selected recommendation';
  const analytics = getAnalytics();
  const preferenceClicks = Number(item.rawMetrics?.preferenceClicks ?? analytics?.categoryCounts?.[category] ?? 0);
  const distanceMeters = Number.isFinite(item.distanceKm) ? Math.max(0, Math.round(item.distanceKm * 1000)) : null;
  const timeSpentSec = Number(item.rawMetrics?.timeSpentSec ?? analytics?.tagTimeSpentSec?.[category] ?? Math.round((item.components?.time || 0) * 10));
  const popularityCount = Number(item.rawMetrics?.popularityCount ?? item.place?.user_ratings_total ?? item.place?.reviewCount ?? 0);

  placeText.textContent = placeName;
  list.innerHTML = `
    <div class="score-breakdown-row"><span>Preference</span><strong>${preferenceClicks}</strong></div>
    <div class="score-breakdown-row"><span>Distance</span><strong>${distanceMeters !== null ? `${distanceMeters}m` : 'N/A'}</strong></div>
    <div class="score-breakdown-row"><span>Time Relevance</span><strong>${timeSpentSec}s</strong></div>
    <div class="score-breakdown-row"><span>Popularity</span><strong>${popularityCount}</strong></div>
  `;

  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeScoreModal(e) {
  if (e && e.target !== document.getElementById('score-modal') && !e.target.classList.contains('modal-close-btn')) return;
  document.getElementById('score-modal').classList.add('hidden');
  document.body.style.overflow = '';
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

function renderProductComparization() {
  ensureComparisonSearchUi();
  bindComparisonSearchEvents();

  const body = document.getElementById('product-comparison-list');
  const totalEl = document.getElementById('cmp-total-products');
  const onlineBetterEl = document.getElementById('cmp-online-better');
  const localBetterEl = document.getElementById('cmp-local-better');
  const hintEl = document.getElementById('comparison-search-hint');
  if (!body || !totalEl || !onlineBetterEl || !localBetterEl) return;

  const activeQuery = String(comparisonSearchQuery || '').trim();
  if (activeQuery) {
    const rows = buildSearchComparisonRows(activeQuery);
    body.innerHTML = '';

    let onlineBetter = 0;
    let localBetter = 0;

    rows.forEach(item => {
      const diffClass = item.diff > 0 ? 'cmp-diff-positive' : item.diff < 0 ? 'cmp-diff-negative' : 'cmp-diff-neutral';
      const diffLabel = item.diff > 0
        ? `Save ${fmtInr(item.diff)}`
        : item.diff < 0
          ? `Pay ${fmtInr(Math.abs(item.diff))} more online`
          : 'No difference';

      const bestOption = item.diff > 0 ? 'Online' : item.diff < 0 ? 'Local Shop' : 'Tie';
      const bestTagClass = item.diff > 0 ? 'online' : item.diff < 0 ? 'local' : 'tie';

      if (item.diff > 0) onlineBetter += 1;
      if (item.diff < 0) localBetter += 1;

      const row = document.createElement('tr');
      row.innerHTML = `
        <td>${item.name}<br /><small class="panel-sub">${item.platform}</small></td>
        <td>#${item.trendingRank}</td>
        <td class="cmp-score">${item.score.toFixed(3)}</td>
        <td>${fmtInr(item.onlinePrice)}</td>
        <td>${fmtInr(item.localPrice)}</td>
        <td class="${diffClass}">${diffLabel}<br /><small>Saved vs MRP: ${fmtInr(item.savedVsMrp)}</small></td>
        <td><span class="cmp-tag ${bestTagClass}">${bestOption}</span></td>
        <td>
          <div class="cmp-links">
            <a class="cmp-link" href="${item.link}" target="_blank" rel="noopener">Open ${item.platform}</a>
          </div>
        </td>`;
      body.appendChild(row);
    });

    totalEl.textContent = rows.length.toLocaleString();
    onlineBetterEl.textContent = onlineBetter.toLocaleString();
    localBetterEl.textContent = localBetter.toLocaleString();
    if (hintEl) {
      hintEl.textContent = `Showing ${rows.length} website comparisons for "${activeQuery}" with links and savings.`;
    }
    return;
  }

  const sorted = [...TRENDING_PRODUCT_PRICES].sort((a, b) => a.trendingRank - b.trendingRank);
  body.innerHTML = '';

  let onlineBetter = 0;
  let localBetter = 0;

  sorted.forEach(item => {
    const links = buildVerificationLinks(item.name);
    const score = computeComparisonProductScore(item);
    const diff = item.localPrice - item.onlinePrice;
    let bestOption = 'Tie';
    let bestTagClass = 'tie';
    let diffClass = 'cmp-diff-neutral';
    let diffLabel = 'No difference';

    if (diff > 0) {
      bestOption = 'Online';
      bestTagClass = 'online';
      diffClass = 'cmp-diff-positive';
      diffLabel = `Save ${fmtInr(diff)}`;
      onlineBetter += 1;
    } else if (diff < 0) {
      bestOption = 'Local Shop';
      bestTagClass = 'local';
      diffClass = 'cmp-diff-negative';
      diffLabel = `Pay ${fmtInr(Math.abs(diff))} more online`;
      localBetter += 1;
    }

    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${item.name}</td>
      <td>#${item.trendingRank}</td>
      <td class="cmp-score">${score.toFixed(3)}</td>
      <td>${fmtInr(item.onlinePrice)}</td>
      <td>${fmtInr(item.localPrice)}</td>
      <td class="${diffClass}">${diffLabel}</td>
      <td><span class="cmp-tag ${bestTagClass}">${bestOption}</span></td>
      <td>
        <div class="cmp-links">
          <a class="cmp-link" href="${links.amazon}" target="_blank" rel="noopener">Amazon</a>
          <a class="cmp-link" href="${links.flipkart}" target="_blank" rel="noopener">Flipkart</a>
          <a class="cmp-link" href="${links.other}" target="_blank" rel="noopener">Other</a>
          <a class="cmp-link" href="${links.local}" target="_blank" rel="noopener">Local Shop</a>
        </div>
      </td>`;
    body.appendChild(row);
  });

  totalEl.textContent = sorted.length.toLocaleString();
  onlineBetterEl.textContent = onlineBetter.toLocaleString();
  localBetterEl.textContent = localBetter.toLocaleString();
  if (hintEl) {
    hintEl.textContent = 'Search a product to compare prices across multiple online websites with links and savings.';
  }
}

function initHackathonDashboard() {
  ensureGoogleMapsLoaded();
  ensureComparisonSearchUi();
  bindComparisonSearchEvents();

  renderPersonalizedMetrics();
  renderBusinessInsights();
  renderDistanceFilterControls();
  renderChatResults(PRODUCT_CATALOG.slice(0, 4));
  renderPersonalizedFilters();
  const saved = localStorage.getItem(personalFilterKey()) || getPreferredCategories()[0] || 'food';
  selectPersonalizedFilter(saved, null, false);
  renderCommunityPosts();
  renderRealityFeed();
  renderCustomWorkRequests();
  renderVacancies();
  renderProductComparization();
}

function switchPage(page, btn) {
  if (page !== 'home') {
    finalizeActivePlaceDashboardSession();
  }

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
    comparization: 'Products Comparization',
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
  if (page === 'comparization') renderProductComparization();
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

window.addEventListener('beforeunload', () => {
  finalizeActivePlaceDashboardSession();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    finalizeActivePlaceDashboardSession();
  }
});
