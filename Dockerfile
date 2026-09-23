# RedRouter container image.
#
# Built from the same npm tarball a release publishes (the red-publish workflow
# passes it in), so the image runs exactly what `npx @reddb-io/red-router` runs,
# minus the launcher and tray: the standalone server, directly.
#
#   docker build --build-arg RR_TARBALL=reddb-io-red-router-<v>.tgz -t red-router release-artifacts
#   docker run -d -p 25050:25050 -v red-router-data:/data -e INITIAL_PASSWORD=... ghcr.io/reddb-io/red-router
#
# Set INITIAL_PASSWORD (dashboard login; the default is 123456) and, for a
# stable session secret across restarts, JWT_SECRET. Everything RedRouter
# stores lives in /data.
FROM node:22-slim

ARG RR_TARBALL=red-router.tgz
WORKDIR /opt/red-router

COPY ${RR_TARBALL} /tmp/red-router.tgz
RUN tar -xzf /tmp/red-router.tgz -C /opt/red-router --strip-components=1 \
  && rm /tmp/red-router.tgz \
  && mkdir -p /data \
  && chown -R node:node /data

ENV NODE_ENV=production \
    PORT=25050 \
    HOSTNAME=0.0.0.0 \
    DATA_DIR=/data \
    HOME=/data \
    NEXT_TELEMETRY_DISABLED=1

USER node
VOLUME /data
EXPOSE 25050

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# custom-server.js wraps the standalone server to take the client IP from the
# socket (not X-Forwarded-For); same entry the CLI launches.
CMD ["node", "--dns-result-order=ipv4first", "app/custom-server.js"]
