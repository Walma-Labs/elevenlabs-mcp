# elevenlabs-mcp — ElevenLabs MCP server for podcast production

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets Claude, Claude Code, Cursor and other MCP clients produce a podcast with [ElevenLabs](https://elevenlabs.io): multi-speaker dialogue, narration, original music, sound effects and a finished, loudness-normalised episode.

Built by [Walma AI](https://walma.ai) for our own podcast. ElevenLabs' original local MCP server is archived, and their hosted MCP focuses on voice agents with basic text to speech, so this one covers what a podcast needs: dialogue, music and assembly.

## Tools

| Tool | What it does |
|---|---|
| `check_subscription` | Plan, credits used and left, reset date |
| `list_models` | Speech models and their languages |
| `list_voices` | Voices in your library, with `voice_id` |
| `search_voice_library` | Search the shared voice library by language, accent, gender, use case |
| `add_library_voice` | Add a shared voice to your library |
| `text_to_speech` | One voice reading a text |
| `text_to_dialogue` | Multi-speaker conversation (`eleven_v3`, audio tags like `[laughs]`). Long scripts are split at line boundaries, chained with `previous_request_ids` and joined |
| `compose_music` | Original intro/outro music and beds (instrumental by default) |
| `sound_effect` | Stingers, whooshes, ambience |
| `list_outputs` | Generated files with durations (local only) |
| `assemble_episode` | Join files with fades, gaps and gain, normalised to -16 LUFS / -1.5 dBTP, MP3 192 kbps (local only) |

Locally, audio is saved to `ELEVENLABS_OUTPUT_DIR` (default `~/elevenlabs-output`); file names are confined to that directory. Used as a library in a hosted server (no output directory), audio is returned inline as MCP audio content and the file tools are not registered.

## Setup

Requires Node 20+ and, for joining long dialogue and assembling episodes, `ffmpeg` on the PATH.

```bash
git clone https://github.com/Walma-Labs/elevenlabs-mcp.git
cd elevenlabs-mcp
npm install   # also builds

mkdir -p ~/.config/elevenlabs-mcp
echo 'ELEVENLABS_API_KEY=sk_...' > ~/.config/elevenlabs-mcp/credentials.env
chmod 600 ~/.config/elevenlabs-mcp/credentials.env

claude mcp add elevenlabs -s user -- node "$PWD/dist/cli.js"
```

Environment variables: `ELEVENLABS_API_KEY` (overrides the file), `ELEVENLABS_CREDENTIALS`, `ELEVENLABS_OUTPUT_DIR`, `ELEVENLABS_BASE_URL` (e.g. `https://api.eu.residency.elevenlabs.io`), `FFMPEG_PATH`, `FFPROBE_PATH`.

## A podcast in four prompts

1. *"Find two English podcast-host voices in the library, one warm and one energetic, and add them."*
2. *"Write a 5-minute episode about MCP servers as a dialogue between them and generate it as ep01-dialogue."*
3. *"Make a 15-second lo-fi intro and a 10-second outro, plus a short whoosh."*
4. *"Assemble ep01: intro (fade out 2 s), dialogue, outro (fade in 1 s)."*

Every generation spends ElevenLabs credits; generate a short sample before a full episode.

## Development

```bash
npm test   # vitest: logic + the MCP wire against a mocked client (needs ffmpeg)
```

MIT licensed.
