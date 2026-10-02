FROM registry.access.redhat.com/ubi9/nodejs-22-minimal:latest

WORKDIR /opt/app-root/src

COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY --chown=1001:0 src ./src

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

USER 1001

CMD ["node", "src/server.js"]
