# Bot Discord de transcription

Un bot Discord qui rejoint un salon vocal sur commande, enregistre la voix de
**chaque participant séparément**, puis délègue la transcription à **Gemini** en
fin de session pour produire un **transcript fusionné chronologique** (qui a dit
quoi, dans l'ordre, horodaté). Le résultat est publié dans le canal texte.

> Conception détaillée : [docs/superpowers/specs/2026-05-31-discord-transcription-bot-design.md](docs/superpowers/specs/2026-05-31-discord-transcription-bot-design.md)

## Comment ça marche

- `/record` → le bot rejoint ton salon vocal, **annonce l'enregistrement** et
  capture le flux audio de chaque utilisateur dans un `.ogg` distinct (un fichier
  par prise de parole), en loggant le timing dans `timeline.json`.
- `/stop` → le bot quitte le vocal, envoie l'audio + le contexte à Gemini,
  reçoit le texte par prise de parole, le fusionne chronologiquement à partir de
  la timeline, et poste `transcript.md` + `transcript.json` dans le canal.

Discord livre déjà un flux audio **séparé par utilisateur** : aucune diarisation
à faire, un fichier = un locuteur. L'Opus est décodé en PCM (via
`@discordjs/opus`) puis ré-encodé en **Opus/Ogg 16 kHz mono** via ffmpeg —
fichiers minuscules, qualité de transcription intacte (Gemini ré-échantillonne à
16 kHz de toute façon). Le binaire ffmpeg est fourni par `ffmpeg-static` : aucune
installation système requise.

> ⚠️ **RGPD / consentement.** Le bot envoie la voix des participants à Google
> (API Gemini) et l'annonce au démarrage. Prévu pour un serveur privé avec des
> participants informés. À recadrer juridiquement si le bot devient public.

## Prérequis

- **Node.js ≥ 22.12**
- Un **bot Discord** (token + client ID)
- Une **clé API Gemini** (Google AI Studio)
- **ffmpeg** : pas besoin de l'installer, le binaire est fourni par le paquet
  `ffmpeg-static` (téléchargé pendant `npm install`).
- Pour l'installation des modules natifs (`sodium-native`, `@discordjs/opus`) :
  - **Windows** : généralement des binaires précompilés sont récupérés
    automatiquement. En cas d'échec de compilation, installe les outils de build
    (`npm install --global windows-build-tools` ou « Desktop development with
    C++ » via Visual Studio Build Tools, + Python 3).
  - **Debian/Linux** : `apt-get install build-essential python3` (déjà géré par
    le `Dockerfile`).

## Installation

```bash
npm install
cp .env.example .env   # puis remplis les valeurs
```

### Créer le bot Discord

1. <https://discord.com/developers/applications> → **New Application**.
2. Onglet **Bot** → **Reset Token** → copie le token dans `DISCORD_TOKEN`.
3. Onglet **General Information** → copie l'**Application ID** dans
   `DISCORD_CLIENT_ID`.
4. Onglet **Bot** → active l'intent **Server Members Intent** (utile pour les
   noms d'affichage). L'intent *Voice State* est couvert par défaut.
5. **Inviter le bot** : onglet **OAuth2 → URL Generator**, scopes `bot` +
   `applications.commands`, permissions **Connect**, **Speak**, **Send
   Messages**, **Attach Files**. Ouvre l'URL générée pour l'ajouter à ton
   serveur.

### Clé Gemini

<https://aistudio.google.com/apikey> → crée une clé, mets-la dans
`GEMINI_API_KEY`. Modèle par défaut : `gemini-2.5-flash` (rapide et économique).

### Variables d'environnement

Voir [.env.example](.env.example). En dev, renseigne `GUILD_ID` (l'ID de ton
serveur de test) pour que les slash commands apparaissent **immédiatement** ;
sans lui, l'enregistrement est global et peut prendre jusqu'à ~1h à se propager.

## Lancer

```bash
npm start
```

Puis sur Discord : rejoins un salon vocal, tape `/record`, parle, puis `/stop`.

## Tests

Les fonctions pures (fusion, formatage, parsing de la réponse Gemini) sont
couvertes par des tests qui tournent **sans token ni dépendances réseau** :

```bash
npm test
```

La capture audio en direct (`recording/recorder.js`) n'est pas couverte par des
tests automatisés — elle se vérifie manuellement en conditions réelles
(`/record` → parler → `/stop`).

## Déploiement Docker (Debian)

```bash
docker build -t discord-transcription-bot .
docker run --env-file .env -v "$PWD/storage:/app/storage" discord-transcription-bot
```

Le volume `storage/` conserve l'audio et les transcripts entre les exécutions.

## Structure

```
src/
  index.js                  # client Discord, enregistrement des commandes, routage
  config.js                 # chargement/validation du .env
  commands/record.js        # /record : rejoint le vocal, démarre la capture
  commands/stop.js          # /stop  : transcrit, fusionne, publie
  recording/session.js      # état d'une session (chemins, timeline, noms)
  recording/recorder.js     # capture Opus -> PCM -> ffmpeg -> .ogg + log du timing
  recording/encode.js       # ré-encodage PCM -> Opus/Ogg 16k mono (ffmpeg)
  recording/registry.js     # sessions actives par serveur
  transcription/gemini.js       # appel réseau Gemini
  transcription/gemini-core.js  # construction requête / parsing (pur, testé)
  transcription/merge.js        # fusion chronologique + rendu md/json (pur, testé)
  output/publish.js         # post Discord + pièces jointes
storage/                    # données par session (audio + transcripts), gitignored
```
