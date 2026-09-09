FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
# Run as non-root user (node user is built into node:alpine images)
USER node
EXPOSE 3000
CMD ["node", "--import", "@elastic/opentelemetry-node", "src/app.js"]
