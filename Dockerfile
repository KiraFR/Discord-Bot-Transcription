FROM node:22-bookworm-slim

# Build tools for the native modules (sodium-native, @discordjs/opus).
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

# Session data (audio + transcripts) is written here; mount a volume.
VOLUME ["/app/storage"]

CMD ["node", "src/index.js"]
