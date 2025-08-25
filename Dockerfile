# Dockerfile for Nova Sonic WebRTC Bridge (WebRTC temporarily disabled)
FROM node:18-slim

# Install basic system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    bash \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci && npm cache clean --force

# Copy source code
COPY . .

# Build the application
RUN npm run build

# Remove source files and dev dependencies to reduce image size
RUN rm -rf src/ *.ts tsconfig.json
RUN npm prune --production

# Create non-root user
RUN groupadd -r nodejs && useradd -r -g nodejs nodejs

# Change ownership of the app directory
RUN chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# Start the application in continuous mode
CMD ["node", "dist/WebRTCBridgeServer.js", "--continuous"]
