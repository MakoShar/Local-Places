const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 4000);
const MONGODB_URI = process.env.MONGODB_URI || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: '1mb' }));

app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'localplaces-backend',
    message: 'Backend is running. Use /api/health to verify database connectivity.',
    endpoints: [
      '/api/health',
      '/api/interactions/click',
      '/api/interactions/time',
      '/api/interactions/impression',
      '/api/recommendations/rank',
    ],
  });
});

app.get('/favicon.ico', (_req, res) => {
  res.status(204).end();
});

const userProfileSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true, index: true },
  tagClicks: { type: Map, of: Number, default: {} },
  tagTimeSpentSec: { type: Map, of: Number, default: {} },
  totalClicks: { type: Number, default: 0 },
  totalDashboardTimeSec: { type: Number, default: 0 },
}, { timestamps: true });

const placeStatsSchema = new mongoose.Schema({
  placeId: { type: String, required: true, unique: true, index: true },
  name: { type: String, default: 'Unknown Place' },
  category: { type: String, default: 'other' },
  rating: { type: Number, default: 0 },
  reviewCount: { type: Number, default: 0 },
  impressions: { type: Number, default: 0 },
  clicks: { type: Number, default: 0 },
  totalDashboardTimeSec: { type: Number, default: 0 },
}, { timestamps: true });

const UserProfile = mongoose.model('UserProfile', userProfileSchema);
const PlaceStats = mongoose.model('PlaceStats', placeStatsSchema);

function getMapMax(mapObj) {
  const values = Object.values(mapObj || {});
  return Math.max(1, ...values, 1);
}

function normalizeCategoryFromTags(place, selectedTag) {
  const tags = Array.isArray(place.tags) ? place.tags.map(x => String(x || '').toLowerCase()) : [];
  const category = String(place.category || '').toLowerCase();
  if (category === String(selectedTag || '').toLowerCase()) return true;
  return tags.includes(String(selectedTag || '').toLowerCase());
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (x) => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getDistanceScore(distanceKm) {
  if (!Number.isFinite(distanceKm)) return 0.3;
  return 1 / (1 + Math.max(0, distanceKm));
}

function getPopularityScore(place, stat) {
  const ratingScore = Math.min(1, Number(place.rating || stat?.rating || 0) / 5);
  const reviewCount = Number(place.reviewCount || stat?.reviewCount || 0);
  const reviewScore = Math.min(1, Math.log10(reviewCount + 1) / 4);

  const clicks = Number(stat?.clicks || 0);
  const impressions = Number(stat?.impressions || 0);
  const engagementScore = Math.min(1, (clicks + impressions * 0.3) / 120);

  return (ratingScore * 0.5) + (reviewScore * 0.2) + (engagementScore * 0.3);
}

app.get('/api/health', async (_req, res) => {
  const dbState = mongoose.connection.readyState;
  res.json({ ok: true, dbConnected: dbState === 1, service: 'localplaces-backend' });
});

app.get('/api', (_req, res) => {
  res.json({
    ok: true,
    service: 'localplaces-backend',
    message: 'API root is live.',
    routes: {
      health: 'GET /api/health',
      click: 'POST /api/interactions/click',
      time: 'POST /api/interactions/time',
      impression: 'POST /api/interactions/impression',
      rank: 'POST /api/recommendations/rank',
    },
  });
});

app.post('/api/interactions/click', async (req, res) => {
  try {
    const { userId, tag, placeId } = req.body || {};
    if (!userId || !tag) {
      return res.status(400).json({ ok: false, error: 'userId and tag are required' });
    }

    const clickPath = `tagClicks.${tag}`;
    await UserProfile.findOneAndUpdate(
      { userId },
      { $inc: { [clickPath]: 1, totalClicks: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    if (placeId) {
      await PlaceStats.findOneAndUpdate(
        { placeId },
        { $inc: { clicks: 1 }, $setOnInsert: { name: 'Unknown Place' } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }

    res.json({ ok: true });
  } catch (error) {
    console.error('click interaction error', error);
    res.status(500).json({ ok: false, error: 'Failed to save click interaction' });
  }
});

app.post('/api/interactions/time', async (req, res) => {
  try {
    const { userId, tag, placeId, durationSec } = req.body || {};
    if (!userId || !tag || !Number.isFinite(durationSec)) {
      return res.status(400).json({ ok: false, error: 'userId, tag and durationSec are required' });
    }

    const timePath = `tagTimeSpentSec.${tag}`;
    await UserProfile.findOneAndUpdate(
      { userId },
      { $inc: { [timePath]: durationSec, totalDashboardTimeSec: durationSec } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    if (placeId) {
      await PlaceStats.findOneAndUpdate(
        { placeId },
        { $inc: { totalDashboardTimeSec: durationSec }, $setOnInsert: { name: 'Unknown Place' } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }

    res.json({ ok: true });
  } catch (error) {
    console.error('time interaction error', error);
    res.status(500).json({ ok: false, error: 'Failed to save time interaction' });
  }
});

app.post('/api/interactions/impression', async (req, res) => {
  try {
    const { items } = req.body || {};
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ ok: false, error: 'items array is required' });
    }

    const updates = items
      .filter(item => item && item.placeId)
      .map(item => ({
        updateOne: {
          filter: { placeId: item.placeId },
          update: {
            $inc: { impressions: 1 },
            $set: {
              name: item.name || 'Unknown Place',
              category: item.category || 'other',
              rating: Number(item.rating || 0),
              reviewCount: Number(item.reviewCount || 0),
            },
          },
          upsert: true,
        },
      }));

    if (updates.length) {
      await PlaceStats.bulkWrite(updates, { ordered: false });
    }

    res.json({ ok: true, updated: updates.length });
  } catch (error) {
    console.error('impression interaction error', error);
    res.status(500).json({ ok: false, error: 'Failed to save impression interaction' });
  }
});

app.post('/api/recommendations/rank', async (req, res) => {
  try {
    const {
      userId,
      selectedTag,
      currentLocation,
      places,
      weights = { preference: 0.4, distance: 0.2, time: 0.2, popularity: 0.2 },
    } = req.body || {};

    if (!userId || !selectedTag || !Array.isArray(places)) {
      return res.status(400).json({ ok: false, error: 'userId, selectedTag and places are required' });
    }

    const profile = await UserProfile.findOne({ userId }).lean();
    const clickMap = profile?.tagClicks || {};
    const timeMap = profile?.tagTimeSpentSec || {};
    const clickMax = getMapMax(clickMap);
    const timeMax = getMapMax(timeMap);

    const placeIds = places.map(p => p.placeId).filter(Boolean);
    const stats = await PlaceStats.find({ placeId: { $in: placeIds } }).lean();
    const statMap = new Map(stats.map(s => [s.placeId, s]));

    const tagFiltered = places.filter(place => normalizeCategoryFromTags(place, selectedTag));
    const candidates = tagFiltered.length ? tagFiltered : places;

    const ranked = candidates.map((place) => {
      const stat = statMap.get(place.placeId);

      const preference = Math.min(1, Number(clickMap[selectedTag] || 0) / clickMax);
      const timeRelevance = Math.min(1, Number(timeMap[selectedTag] || 0) / timeMax);

      const distanceKm =
        currentLocation && place.location &&
        Number.isFinite(currentLocation.lat) && Number.isFinite(currentLocation.lng) &&
        Number.isFinite(place.location.lat) && Number.isFinite(place.location.lng)
          ? haversineKm(currentLocation.lat, currentLocation.lng, place.location.lat, place.location.lng)
          : null;

      const distance = getDistanceScore(distanceKm);
      const popularity = getPopularityScore(place, stat);

      const score =
        (preference * Number(weights.preference || 0.4)) +
        (distance * Number(weights.distance || 0.2)) +
        (timeRelevance * Number(weights.time || 0.2)) +
        (popularity * Number(weights.popularity || 0.2));

      const popularityCount = Number(stat?.impressions || 0) + Number(stat?.clicks || 0) + Number(place.reviewCount || stat?.reviewCount || 0);

      return {
        placeId: place.placeId,
        score,
        distanceKm,
        components: {
          preference,
          distance,
          time: timeRelevance,
          popularity,
        },
        rawMetrics: {
          preferenceClicks: Number(clickMap[selectedTag] || 0),
          timeSpentSec: Number(timeMap[selectedTag] || 0),
          popularityCount,
        },
        explanation: `Recommended because ${selectedTag} interest + distance + time spent + public popularity`,
      };
    }).sort((a, b) => b.score - a.score);

    res.json({ ok: true, ranked });
  } catch (error) {
    console.error('rank recommendation error', error);
    res.status(500).json({ ok: false, error: 'Failed to rank recommendations' });
  }
});

async function startServer() {
  try {
    if (!MONGODB_URI) {
      throw new Error('MONGODB_URI is missing. Add it to backend/.env');
    }

    await mongoose.connect(MONGODB_URI);
    console.log('MongoDB connected');

    app.listen(PORT, () => {
      console.log(`Backend running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Server start failed:', error.message);
    process.exit(1);
  }
}

startServer();
