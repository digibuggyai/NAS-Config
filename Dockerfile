# Works on any platform that takes a container: Render, Railway, Fly, a plain VPS.
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first, so a code change doesn't reinstall them.
COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/
COPY backend/package.json ./backend/
RUN npm ci --omit=dev

COPY backend ./backend
COPY frontend ./frontend

# Never run as root, and never ship a local database or credentials — see
# .dockerignore, which excludes backend/.env and backend/data.
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "backend/index.js"]
