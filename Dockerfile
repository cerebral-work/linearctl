# syntax=docker/dockerfile:1.7

# Bun build stage — compile the single binary
FROM oven/bun:1.3.14 AS build
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile --production
COPY src/ src/
COPY docs/ docs/
COPY .linearctl/ .linearctl/
RUN bun build ./src/index.ts --compile --minify --outfile dist/linearctl

# Distroless runtime — minimal attack surface
FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /app
COPY --from=build /app/dist/linearctl /app/linearctl
COPY --from=build /app/.linearctl /app/.linearctl
USER nonroot:nonroot
ENTRYPOINT ["/app/linearctl"]
CMD ["operator", "--json"]
