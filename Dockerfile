FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production \
    PORT=5012 \
    HOST=0.0.0.0

RUN addgroup -S app && adduser -S app -G app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && chown -R app:app /app

COPY --chown=app:app index.js ./
COPY --chown=app:app src ./src

USER app
EXPOSE 5012

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5012/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
