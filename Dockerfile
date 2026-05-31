FROM node:22-bookworm-slim

# Outils de compilation pour les modules natifs (sodium-native, @discordjs/opus).
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

# Les sessions (audio + transcripts) sont écrites ici ; monter un volume.
VOLUME ["/app/storage"]

CMD ["node", "src/index.js"]
