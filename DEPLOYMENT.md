# Deploy Afisha on the shared server

Deploy the web app at `https://afishabash.duckdns.org`. Run Afisha as its own Docker Compose project. Route only this hostname through the server’s existing reverse proxy. Leave the two existing sites, their containers, listeners, DNS, certificates, and data in place.

## 1. Inventory the server before making changes

- Use an isolated release directory such as `/srv/afishabash/app`. Transfer the **updated app source**, including the weekday fix and new files, from the authorized checkout or release artifact. A checkout of an older remote revision will omit local changes. Keep `.env` and data backups out of Git and transfer them separately through an approved secure channel.
- Inspect `sudo ss -ltnp`, `docker ps --format '{{.Names}}\t{{.Ports}}'`, `docker compose ls`, and the active reverse proxy’s service and configuration. Identify what owns `80` and `443`, the two existing hostnames and their upstreams, and whether the proxy runs on the host or in Docker. Record both existing sites’ HTTP statuses and a content marker or redirect target before changing anything. Use each site's normal health or landing URL.
- Check `dig +short A afishabash.duckdns.org` and `dig +short AAAA afishabash.duckdns.org` against the server’s public addresses. Update only the `afishabash` DuckDNS record through the owner’s existing update method if necessary. An AAAA record must reach this server over IPv6. Preserve the other sites’ records and any shared DuckDNS updater.
- Use the explicit project name `afishabash` only after confirming it is unused or already belongs to this app. Check `docker compose version` and verify the port overrides with `config` before starting services. Refer to [Docker Compose project names](https://docs.docker.com/compose/how-tos/project-name/) and [Compose merge and reset rules](https://docs.docker.com/reference/compose-file/merge/).

## 2. Configure Afisha

Create the project’s `.env` from `.env.example` if it does not exist. Set its permissions to `600`. Keep existing Afisha credentials if updating an installed instance. For a new instance set a unique `POSTGRES_PASSWORD` and `PUBLIC_SITE_URL=https://afishabash.duckdns.org` with no trailing slash. The exact public origin is used for account requests and HTTPS cookies.

- Configure `TIMEWEB_API_KEY` and `BASE_URL` for AI discovery. The app defaults to `openai/gpt-6-luna` for Timeweb. Configure `OPENAI_API_KEY` if using OpenAI Whisper for voice.
- If available, set the browser key `YANDEX_MAPS_JS_API_KEY` and allow `afishabash.duckdns.org` on the key in the Yandex dashboard. Test the embedded route after launch. The link to Yandex Maps works when the embedded route is unavailable.
- For Telegram polling, set the authorized `BOT_TOKEN` and a separate `BOT_API_TOKEN` shared by the Afisha API and bot. Run one poller per token. Coordinate any cutover from a local poller or webhook for this token. Telegram sign-in separately uses `TELEGRAM_CLIENT_ID` and `TELEGRAM_CLIENT_SECRET`. Register `https://afishabash.duckdns.org` and `https://afishabash.duckdns.org/api/v1/auth/telegram/callback` with BotFather. The web app can launch with both Telegram features disabled.

Create `compose.server.yaml` on the server beside `docker-compose.yml`. Pick the variant that matches the existing proxy.

**Host reverse proxy.** Select an unused loopback port after the inventory. `13080` is an example. Set `WEB_PORT=13080` in `.env` to match the chosen port. The base Compose file already binds web to `127.0.0.1`.

```yaml
services:
  db:
    ports: !reset []
    restart: unless-stopped
  api:
    ports: !reset []
    restart: unless-stopped
  web:
    restart: unless-stopped
  bot:
    restart: unless-stopped
```

**Containerized reverse proxy.** Use the proxy’s existing user-defined Docker network. Replace `ACTUAL_PROXY_NETWORK` with the observed network name. Attach only Afisha’s web container to it, and verify `afishabash-web` is a unique network alias. Keep the network external so Compose leaves it in place when removing the Afisha stack.

```yaml
services:
  db:
    ports: !reset []
    restart: unless-stopped
  api:
    ports: !reset []
    restart: unless-stopped
  web:
    ports: !reset []
    restart: unless-stopped
    networks:
      default: {}
      proxy:
        aliases: [afishabash-web]
  bot:
    restart: unless-stopped
networks:
  proxy:
    external: true
    name: ACTUAL_PROXY_NETWORK
```

From the app directory, use this helper in Bash for every operation on Afisha. It scopes commands to Afisha’s containers, network, and volume. Run `config --quiet` and show only resolved port mappings so secrets do not reach logs or the agent transcript.

```bash
afisha() { docker compose -p afishabash -f docker-compose.yml -f compose.server.yaml "$@"; }
afisha config --quiet
afisha config --format json | jq -r '.services | to_entries[] | [.key, ((.value.ports // []) | map("\(.host_ip // "all"):\(.published) -> \(.target)") | join(", "))] | @tsv'
```

Expect `127.0.0.1:<chosen port> -> 80` on `web` for a host proxy, or all blank port columns for a containerized proxy. In both cases `db` and `api` must have no host port. Recheck the chosen port with `ss` just before starting. If it is in use, choose another port and repeat validation. Keep the existing firewall and owners of `80` and `443` in place.

## 3. Start Afisha and prepare the catalog

For a new install, an empty database triggers a source refresh when `BOOTSTRAP_CATALOG=1`. Allow it to finish before judging search coverage. To seed an existing Afisha catalog instead, restore an authorized Afisha PostgreSQL backup into this project's new database before starting the API. Use a compatible backup from the Afisha database only. Confirm separately whether account/chat data may be transferred. Afisha’s local SQLite catalog is excluded from the Docker build. If SQLite is the source to migrate, transfer it separately, mount it read-only into a one-off API container, and run the migration before the API starts.

```bash
# For a new database, before the API starts. Skip this block for a source refresh.
afisha up -d --wait db
# Choose ONE import method if a catalog was supplied.
# afisha exec -T db pg_restore --no-owner --no-privileges --exit-on-error -U afisha -d afisha < /secure/path/afisha.dump
# afisha run --rm --no-deps -v /secure/path/catalog.sqlite:/tmp/catalog.sqlite:ro api node apps/api/src/migrate.ts /tmp/catalog.sqlite

# Start the web app and its dependencies.
afisha up -d --build --wait db api web
afisha ps
# Check the public catalog after bootstrap. If it is still empty and startup refresh finished:
# afisha exec api npm run refresh
```

If using SQLite, confirm the runtime `node` user can read the mounted file. If a live Afisha deployment already exists, take a backup and inspect its database volume before release. Keep the volume. Run a manual refresh only after the startup refresh finishes to avoid overlapping runs.

## 4. Add the domain to the existing proxy

Test Afisha’s upstream `/health` and `/api/v1/events?limit=1` through the chosen loopback port or from inside the proxy network before publishing the domain. Upstream is `127.0.0.1:<chosen port>` for the host proxy and `afishabash-web:80` for the container proxy.

Back up the specific proxy config being edited. Add one exact-host rule for `afishabash.duckdns.org` using the proxy’s existing config layout and TLS issuance method. Forward the whole URL space to the Afisha web service, including `/api/`, `/health`, application pages, and static assets. Preserve the public host and incoming `Origin` header. Keep the existing default rule and the other sites’ configuration.

- **NGINX**. Add a separate `server_name afishabash.duckdns.org` virtual host to the active configuration. Use the established certificate workflow for this hostname and add the following inside its HTTPS server block. Set the port to the selected loopback port or use the container upstream. Run `nginx -t` in the same host or container as the proxy, then gracefully reload the active proxy. [NGINX reverse proxy documentation](https://docs.nginx.com/nginx/admin-guide/web-server/reverse-proxy/)

  ```nginx
  location / {
      proxy_pass http://127.0.0.1:13080;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      client_max_body_size 2m;
  }
  ```

- **Caddy**. If this is the active proxy, add the following site block using its existing TLS settings. Use the container upstream instead when needed. Validate with `caddy validate --config <active-config>` before gracefully reloading through the existing service. [Caddy reverse proxy documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)

  ```caddyfile
  afishabash.duckdns.org {
      reverse_proxy 127.0.0.1:13080
  }
  ```

For another proxy, add the equivalent exact-host rule using that proxy’s validation and reload procedure. Use certificate issuance that works alongside the running proxy, such as its managed TLS, webroot, or DNS validation. Avoid standalone certificate mode on shared ports. If the active proxy is in a container, recheck its upstream resolution after recreating Afisha’s web container and use the proxy’s normal graceful reload if needed.

## 5. Verify and hand back

```bash
curl -fsS https://afishabash.duckdns.org/health
curl -fsS 'https://afishabash.duckdns.org/api/v1/events?limit=1' | jq '{total, returned: (.events | length)}'
curl -fsS https://afishabash.duckdns.org/ -o /dev/null
```

- Check HTTPS without `-k`, compare both existing sites with the pre-deployment baseline, and confirm only the intended Afisha port or proxy alias was added. Confirm PostgreSQL and Fastify have no public listeners.
- Replay `Я хочу провести весь день с семьёей` → `Несколько событий и в городе Салават` → `на пн` → `На машине`. The weekday should resolve to the upcoming local Monday and stay out of the keyword filter. If the date has no events, the answer should identify it and offer the next verified date in Salavat when available. Check that signing in and reopening a saved chat works over the public HTTPS origin.
- If Telegram polling is part of this release and the previous Afisha poller has been stopped, run `afisha --profile telegram up -d --build bot` and verify the same conversation in the bot. There is no inbound Telegram port for polling.
- If a proxy change fails validation, leave the running proxy in place. If verification fails after reload, restore the backed-up site config and validate and gracefully reload it. Stop only Afisha services if necessary with `afisha stop`. Retain the database volume. For subsequent updates back up Afisha with `afisha exec -T db pg_dump -U afisha -d afisha -Fc > /secure/path/afisha.dump` and retain the previous release so you can rebuild it.
- Report the deployed revision, selected proxy/upstream, HTTPS and catalog checks, before/after results for both existing sites, and any pending integration checks. Keep credentials out of the report.
