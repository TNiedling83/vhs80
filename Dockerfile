FROM node:22-alpine
WORKDIR /app
COPY server.js ./
COPY public ./public
ENV PORT=80 DATA_FILE=/data/state.json
RUN mkdir -p /data
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1/health || exit 1
CMD ["node", "server.js"]
