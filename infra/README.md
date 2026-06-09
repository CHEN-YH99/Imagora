# Imagora Local Runtime

This Compose file starts the web app, API, worker, PostgreSQL, and Redis.

```bash
docker compose -f infra/docker-compose.yml up
```

This is a development runtime. The app still uses the local JSON store by default, while PostgreSQL and Redis are available for the Prisma/BullMQ migration checkpoint.
