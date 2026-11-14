# Synthetic analytics data

The v3 bundle contains fictional events, prices and `demo.example` URLs. The full fixture has 126 rows and the clean subset has 104 rows. The 38-row fixture, legacy full fixture and ID mapping are retained for reference. The supplied source notes document venue checks and candidate event feeds. [Source notes](./DATA_SOURCES.md)

The catalog keeps each fixture UUID in the source key and raw record and assigns its own canonical ID. The supplied v3 expectations distinguish 120 keys under the bundle's rule from 101 manually labelled events. The application's identity uses normalized title, city, venue and full start time. The import and reimport tests exercise that identity; they do not grade the bundle's calendar-day rule.

To inspect the data through the real API, run from the app directory:

```sh
node scripts/demo-analytics.ts
```

Add `--clean` to load the 104-row subset instead.

This starts an isolated in-memory catalog on `http://127.0.0.1:3012`. It does not load `.env`, refresh external sources, or call an AI model. The clock is fixed at 13 November 2026, so the historical fixture remains searchable. Stop it with Ctrl+C.

In Postman, use `GET http://127.0.0.1:3012/api/v1/events?maxPrice=0&age=0`. No headers or body are required. A 200 response contains an `events` array including «Ярмарка выходного дня» with zero minimum price and age limit. `GET http://127.0.0.1:3012/api/v1/events?maxPrice=-1` returns 400. For conversational search, send `POST http://127.0.0.1:3012/api/v1/discover` with `Content-Type: application/json` and body `{"message":"Куда пойти в Уфе?"}`. The 200 response uses local search only.
