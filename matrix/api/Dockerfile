FROM oven/bun:latest
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --trust
COPY matrix.ts .
CMD ["bun", "matrix.ts"]
