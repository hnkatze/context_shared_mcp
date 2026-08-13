# The repository holds three deployables; this image builds only the MCP
# server, so Railway needs no Root Directory setting to find it.
FROM node:22-slim AS build
WORKDIR /app
COPY mcp/package.json mcp/package-lock.json ./
RUN npm ci
COPY mcp/tsconfig.json ./
COPY mcp/src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY mcp/package.json mcp/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Railway injects PORT; this is only the local default.
ENV PORT=8080
EXPOSE 8080
CMD ["npm", "start"]
