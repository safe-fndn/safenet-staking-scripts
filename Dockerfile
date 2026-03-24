# ---- Base Image ----
FROM node:24-slim AS base
WORKDIR /app

# ---- Builder Stage ----
FROM base AS builder

# Copy over package files and install dependencies.
COPY package.json package-lock.json ./
RUN npm ci

# Copy over our source and build.
COPY src/ src/
COPY tsconfig.json tsconfig.dist.json ./
RUN npm run build

# ---- Runner Stage ----
FROM base AS runner

# Install only runtime dependencies to keep the image as lean as possible.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Copy the compiled code and compiled native code from the builder stage.
COPY --from=builder /app/dist/ dist/
COPY --from=builder /app/node_modules/better-sqlite3/build/ node_modules/better-sqlite3/build/

# Copy the container entrypoint script.
COPY bin/entrypoint.sh bin/entrypoint.sh

# Install an init program to run our script.
RUN apt-get update && apt-get install -y tini

# Set the node environment and our entrypoint.
ENV NODE_ENV=production
ENTRYPOINT ["tini", "/app/bin/entrypoint.sh", "--"]
