# Static SPA + backend

A Vite SPA is built into a static artifact and mounted at `/`. A separate
Node.js API is built as a compute artifact and mounted at `/api`.

```powershell
npm install
npm run build
npm run start:api
```

Set `PORT` to override the API's default port of `8080`. During local
development, run `npm run dev:web` and `npm run dev:api` in separate terminals.

