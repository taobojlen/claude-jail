FROM oven/bun:latest AS build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install
COPY scheduler.ts .
RUN bun build --compile --outfile=scheduler scheduler.ts

FROM debian:bookworm-slim
COPY --from=build /app/scheduler /usr/local/bin/scheduler
CMD ["scheduler"]
