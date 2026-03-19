FROM node:24-slim
WORKDIR /app

# Install all dependencies, including devDependencies (tsx is needed at runtime).
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and TypeScript config.
COPY src/ src/
COPY tsconfig.json ./

# Copy and permission the entrypoint script.
COPY bin/entrypoint.sh bin/entrypoint.sh
RUN chmod +x bin/entrypoint.sh

ENTRYPOINT ["/app/bin/entrypoint.sh"]
