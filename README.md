# Crocodile backend

Express 5 and Socket.IO server. Requires Node.js 24.18.0 or newer and npm.

## Run

- npm ci: install the locked dependency tree.
- npm run dev: start with nodemon reloads.
- npm start: start with Node.js on port 9999.
- npm run lint: Oxlint correctness checks; warnings fail.
- npm audit: dependency security report.

nodemon and Oxlint are development dependencies. Production can use npm ci --omit=dev and npm start.

## Existing API

- GET /game: existing JSON serialization of the in-memory rooms Map (currently {}).
- POST /game: accepts a JSON object with roomId and optional userName; creates a room if needed and returns an empty 200 response. Missing/unparsed JSON body returns 400 with an error object.
- Socket.IO ROOM:JOIN: logs the received payload; no acknowledgement or broadcast is implemented.
- HTTP and Socket.IO CORS retain the existing wildcard origin policy.

The upgrade preserves the existing room data and event behavior. All direct dependencies are pinned to stable versions, and package-lock.json locks transitives. cors is declared explicitly.
