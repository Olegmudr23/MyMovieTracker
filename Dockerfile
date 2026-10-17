FROM node:24-alpine
WORKDIR /app
COPY package.json server.mjs catalog-cache.mjs ./
COPY public ./public
RUN mkdir /app/data && chown -R node:node /app
USER node
ENV PORT=3000 DATABASE_PATH=/app/data/kinocircle.sqlite COOKIE_SECURE=1
EXPOSE 3000
CMD ["node", "server.mjs"]
