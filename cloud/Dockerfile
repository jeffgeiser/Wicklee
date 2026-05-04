# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM rust:1.88-slim AS builder

WORKDIR /app

# DuckDB bundled feature compiles DuckDB from C++ source.
# build-essential provides g++/gcc/make; cmake drives the DuckDB configure step.
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential cmake \
 && rm -rf /var/lib/apt/lists/*

# Cache dependency compilation separately from source changes.
COPY Cargo.toml Cargo.lock ./
RUN mkdir -p src && echo "fn main(){}" > src/main.rs && cargo build --release
RUN rm -f target/release/deps/wicklee_cloud*

# Now bring in real source and rebuild only that.
COPY src ./src
# Static data files embedded into the binary via include_str! at compile time.
# Currently: perplexity_baseline.json — empirical KLD/PPL data for the
# Perplexity Tax fit-score multiplier.  Mirror at public/ for browser delivery
# is kept in sync by scripts/sync-perplexity.mjs at frontend build time.
COPY data ./data
RUN cargo build --release

# ── Stage 2: minimal runtime image ────────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/wicklee-cloud /usr/local/bin/wicklee-cloud

EXPOSE 8080

CMD ["wicklee-cloud"]
