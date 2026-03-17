# LocalPlaces Backend (Node.js + MongoDB Atlas)

## 1. Configure
1. Copy `.env.example` to `.env`
2. Set `MONGODB_URI` with your MongoDB Atlas connection string
3. Optionally set `ALLOWED_ORIGIN` to your frontend URL

## 2. Install and Run
```bash
cd backend
npm install
npm run dev
```
Server starts on `http://localhost:4000` by default.

## 3. API Endpoints
- `GET /api/health`
- `POST /api/interactions/click`
- `POST /api/interactions/time`
- `POST /api/interactions/impression`
- `POST /api/recommendations/rank`

## 4. Score Formula Used
`Score = (User Preference x 0.4) + (Distance x 0.2) + (Time Relevance x 0.2) + (Popularity x 0.2)`

Where:
- User Preference = tag click frequency for the selected tag
- Distance = based on current location and shop location
- Time Relevance = dashboard time spent for the selected tag
- Popularity = public engagement + rating + review count
