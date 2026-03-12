# ── Stage 1: build the React frontend ────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

# Install dependencies first (layer-cached until package.json changes).
COPY package*.json ./
RUN npm ci

# Declare all VITE_* build-time env vars as ARGs so Railway passes them
# through to the Docker build stage. Vite replaces import.meta.env.VITE_*
# at compile time — if they're missing here the built bundle gets undefined.
ARG VITE_CLERK_PUBLISHABLE_KEY
ARG VITE_CLOUD_URL
# Make them visible to the npm run build process as environment variables.
ENV VITE_CLERK_PUBLISHABLE_KEY=$VITE_CLERK_PUBLISHABLE_KEY
ENV VITE_CLOUD_URL=$VITE_CLOUD_URL

# Copy source and build the cloud frontend (standard mode, not agent mode).
# Output lands in agent/frontend/dist per vite.config.ts.
COPY . .
RUN npm run build

# ── Stage 2: serve with nginx + API reverse proxy ─────────────────────────────
FROM nginx:alpine

# Install gettext for envsubst (substitutes $PORT in the nginx config).
RUN apk add --no-cache gettext

# Copy built assets from stage 1.
COPY --from=builder /app/agent/frontend/dist /usr/share/nginx/html

# Install the nginx config as a template (not default.conf — entrypoint.sh
# writes the final config after substituting $PORT).
COPY nginx.conf /etc/nginx/conf.d/nginx.conf.template

# Remove the default nginx config so our template is the only one loaded.
RUN rm -f /etc/nginx/conf.d/default.conf

# Copy and install the entrypoint script.
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 80

ENTRYPOINT ["/entrypoint.sh"]
