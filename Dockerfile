# syntax=docker/dockerfile:1.7

# Bun build stage — compile the single standalone binary (PR #120).
# Pinned by digest so a registry-side tag retag can never silently swap the
# builder. The standalone binary is compiled with --define process.env.DEV=false
# (no react-devtools runtime dependency baked in).
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile --production
COPY src/ src/
COPY docs/ docs/
COPY .linearctl/ .linearctl/
# src/lib/examples.ts imports examples/*.sh as text; the compile fails without them.
COPY examples/ examples/
# `bun run build` uses the chart-pinned --define (single source of truth in
# package.json); the compiled binary is fully standalone (no Node runtime).
RUN bun run build

# Distroless runtime — minimal attack surface, NO Node runtime image.
# `base-nossl-debian12:nonroot` ships only the glibc/ca-certificates base the
# compiled Bun binary needs; there is no nodejs, npm, shell, or package manager to
# exploit. "nossl": Bun links BoringSSL statically and the binary NEEDs only libc,
# libpthread, libdl and libm, so the system libssl3 is dead weight that only adds
# CVEs (CVE-2026-84782 blocked the build scan on 2026-10-07).
# Pinned by digest (canonical manifest) — no `latest` drift.
FROM gcr.io/distroless/base-nossl-debian12:nonroot@sha256:be40c00dfabd86576d92666e87e406714d5618342de1a0c213ad232de255172e
WORKDIR /app
COPY --from=build /app/dist/linearctl /app/linearctl
COPY --from=build /app/.linearctl /app/.linearctl
USER nonroot:nonroot
ENTRYPOINT ["/app/linearctl"]
# Default operator workload: boot both shipped roles, JSON output for logs.
CMD ["operator", "--role", "intake-triage", "--role", "grooming", "--json"]
