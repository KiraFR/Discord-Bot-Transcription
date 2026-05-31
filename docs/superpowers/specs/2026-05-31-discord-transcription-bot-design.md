# Bot Discord de transcription — Design

**Date :** 2026-05-31
**Statut :** validé (en attente de relecture finale avant plan d'implémentation)

## Objectif

Un bot Discord qui rejoint un canal vocal sur commande, enregistre la voix de
chaque participant séparément, puis délègue la transcription à Gemini en fin de
session pour produire un **transcript fusionné chronologique** (qui a dit quoi,
dans l'ordre, horodaté). Le résultat est publié dans le canal texte.

## Choix d'architecture clés

- **Batch, pas live.** On enregistre pendant la session et on transcrit en une
  fois à la fin (`/stop`). Cela supprime tout le pipeline temps réel (streaming
  STT, resampling ffmpeg, orchestration par utterance, GPU local).
- **Une seule app Node.js.** Pas de service STT séparé : Gemini est distant.
- **Transcription déléguée à Gemini.** Audio + métadonnées de timing envoyés à
  l'API Google Gen AI ; Gemini fournit le texte, notre code fournit l'ordre et
  les horodatages.
- **Pas de diarisation à faire.** Discord livre déjà un flux Opus par
  utilisateur (mapping SSRC → user ID) : un fichier = un locuteur.

### Compromis RGPD assumé

La voix des participants est envoyée à Google (API Gemini). C'est acceptable
pour un usage de serveur privé avec des participants informés. Le bot **annonce
l'enregistrement** à `/record`. À recadrer si le bot devient public.

## Flux de bout en bout

```
/record → rejoint le vocal de l'appelant (selfDeaf:false)
        → annonce "🔴 enregistrement en cours pour transcription"
        → pour chaque user qui parle : capture Opus → écrit un .ogg par prise de parole
        → logge le timing de chaque prise de parole dans timeline.json
/stop   → quitte le vocal, finalise les fichiers
        → construit la requête Gemini (audio trié + contexte) → JSON structuré
        → fusionne en transcript chronologique
        → poste un résumé + joint transcript.md et transcript.json dans le canal
```

## Composants

| Composant | Rôle | Dépend de |
|-----------|------|-----------|
| `commands/record.js`, `commands/stop.js` | Handlers des slash commands | discord.js, recording |
| `recording/session.js` | État d'une session : chemins, timeline, participants | — |
| `recording/recorder.js` | Rejoint le vocal, s'abonne aux flux, écrit les .ogg, logge le timing | @discordjs/voice, prism-media |
| `transcription/gemini.js` | Construit la requête, appelle Gemini, parse le JSON | @google/genai |
| `transcription/merge.js` | Trie les utterances, injecte le texte, rend md + json | — (fonctions pures) |
| `output/publish.js` | Poste le message + joint les fichiers | discord.js |
| `config.js` | Charge et valide le `.env` | — |
| `index.js` | Bootstrap client, enregistrement des commandes, wiring des events | tout |

Chaque unité a un rôle unique et une interface claire ; `merge.js` et le parsing
de `gemini.js` sont des fonctions pures testables isolément.

## Capture audio (détail)

- À chaque `speaking.start` d'un utilisateur (déduplication via un `Set` pour ne
  s'abonner qu'une fois par prise de parole), on `subscribe` au flux Opus avec
  `EndBehaviorType.AfterSilence` (durée de silence configurable, ~800 ms).
- **Décodage Opus → PCM → ffmpeg → Opus/Ogg 16 kHz mono.** Le plan initial
  (écrire l'Opus brut via `prism.opus.OggLogicalBitstream`) a été abandonné :
  cette API n'existe que dans une version GitHub/beta de `prism-media`, pas dans
  le npm stable (1.3.5). On décode donc l'Opus en PCM s16le via
  `prism.opus.Decoder` (backé par `@discordjs/opus`), puis on **ré-encode via
  ffmpeg** (`recording/encode.js`) en **Opus/Ogg 16 kHz mono** (~24 kbps). Le
  binaire ffmpeg est fourni par le paquet `ffmpeg-static` (aucune installation
  système). Gemini ré-échantillonnant à 16 kHz en interne, le mono 16 kHz ne
  dégrade pas la transcription, et les fichiers sont ~60× plus petits qu'un WAV
  48 kHz stéréo : une session entière tient souvent dans un seul appel Gemini.
- **Un fichier .ogg par prise de parole :**
  `storage/<guildId>/<sessionId>/<userId>/<index>.ogg` (le `startMs` est dans
  `timeline.json`).
- En parallèle, `timeline.json` accumule une entrée par prise de parole :
  `{ userId, displayName, index, startMs, endMs }` où `startMs` est relatif au
  début de session. **C'est la source de vérité de l'ordre et des horodatages.**

## Transcription Gemini

**Stratégie retenue (option A — découpage par prise de parole) :**

- On construit **un appel Gemini** contenant les utterances triées par `startMs`,
  chacune en *part audio* (`audio/ogg`) précédée d'un marqueur texte
  (`Utterance 12 — Alice — 00:03:12`), suivi du **contexte** (noms des
  participants, glossaire/jargon optionnel) et d'un `responseSchema` =
  tableau `{ index, text }`.
- L'horodatage et le locuteur proviennent de **notre** timeline (déterministe) ;
  Gemini ne fournit que le texte. Alignement fiable, le contexte améliore les
  noms propres.

**Sessions longues** (> ~20 Mo de requête ou dépassement de contexte) :
découpage en fenêtres temporelles, plusieurs appels, concaténation des résultats.
Au-delà de l'inline (~20 Mo), bascule sur la File API de Gemini.

**Modèle :** `gemini-2.5-flash` par défaut (rapide, peu cher, bon en audio),
`gemini-2.5-pro` configurable via `.env` si audio difficile.
**SDK :** `@google/genai`.
**Langue :** configurable, français par défaut (hint passé à Gemini).

## Fusion & sortie

- Tri de toutes les utterances par `startMs`, injection du texte renvoyé par
  Gemini, rendu de deux artefacts :
  - `transcript.md` : `[HH:MM:SS] Alice : …`, une ligne par prise de parole.
  - `transcript.json` : `[{ start, end, speaker, userId, text }]`.
- Le bot poste un court message dans le canal où `/stop` a été tapé et joint les
  deux fichiers.
- Les `.ogg` et `timeline.json` sont **conservés sur disque** après publication
  (permet une retranscription si l'appel Gemini échoue).

## Commandes & consentement

- `/record` : rejoint le canal vocal de l'appelant, démarre l'enregistrement,
  **annonce l'enregistrement** dans le canal texte (consentement RGPD / CGU
  Discord). Refuse si l'appelant n'est pas en vocal ou si une session est déjà
  active sur le serveur.
- `/stop` : clôt la session, transcrit, publie. Refuse s'il n'y a pas de session
  active.

## Gestion d'erreurs

- **Personne n'a parlé** → message gracieux, pas d'appel Gemini.
- **Déconnexion vocale en cours de session** → finalisation des fichiers en
  cours, on n'écrase rien.
- **Échec de l'appel Gemini** → on conserve audio + timeline, message d'erreur
  clair dans le canal ; la retranscription manuelle reste possible (les fichiers
  sont là).
- **Modules natifs manquants** (sodium, opus) → la connexion vocale échoue ;
  documenté dans le README.

## Stack & déploiement

- **Runtime :** Node 22.12+.
- **Dépendances :** discord.js v14, `@discordjs/voice`, `prism-media`,
  `sodium-native`, `@discordjs/opus`, `ffmpeg-static`, `@google/genai`.
- **Config (`.env`) :** `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `GEMINI_API_KEY`,
  `GEMINI_MODEL`, `TRANSCRIPT_LANG`, `SILENCE_MS`, `GUILD_ID` (optionnel, pour
  l'enregistrement rapide des commandes en dev).
- **Dev :** sur Windows (npm install compile les modules natifs ; prérequis build
  documentés dans le README).
- **Prod :** Docker sur Debian (`node:22-bookworm-slim` + `build-essential`),
  volume monté pour `storage/`.

### Structure du projet

```
src/
  index.js
  config.js
  commands/
    record.js
    stop.js
  recording/
    session.js
    recorder.js
  transcription/
    gemini.js
    merge.js
  output/
    publish.js
storage/              # données par session (audio + json), gitignored
docs/
Dockerfile
.env.example
README.md
package.json
```

## Tests

- **Unitaires :** `merge.js` (tri/formatage, fonctions pures) et le parsing de la
  réponse Gemini dans `gemini.js` (SDK mocké). Cadre/factorise la construction de
  requête pour qu'elle soit testable sans réseau.
- **Recorder (audio live) :** difficile à tester sans vocal réel → checklist de
  test manuel ; si faisable, un test du chemin d'écriture OGG avec une fixture de
  paquets Opus.
- Transparence sur ce qui est couvert vs vérifié manuellement.

## Hors périmètre (YAGNI)

- Transcription temps réel / sous-titres live.
- STT local (faster-whisper / whisper.cpp) — écarté au profit de Gemini.
- Bot public multi-serveurs avec gestion fine du consentement par participant.
- Diarisation (inutile : Discord sépare déjà par utilisateur).
- Résumé / compte-rendu automatique (extension possible plus tard, pas dans ce
  périmètre).
