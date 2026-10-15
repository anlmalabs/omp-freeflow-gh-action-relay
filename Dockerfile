FROM node:22-alpine
WORKDIR /app
COPY package.json server.mjs ./
RUN npm install --omit=dev
EXPOSE 3000-3015
CMD ["node", "server.mjs"]
