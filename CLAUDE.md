# Social Recipe AnyList

## Purpose

This is a private personal application that imports recipe videos from Instagram and TikTok, extracts a structured recipe, and saves the result to AnyList.

## Primary User Flow

Instagram/TikTok
→ iOS Share Sheet
→ Save Recipe Shortcut
→ Backend
→ Recipe Extraction
→ AnyList

## V1 Goal

Given one public Instagram Reel or TikTok URL:

1. Extract source content.
2. Produce normalized Recipe JSON.
3. Save the recipe into AnyList.

The initial development interface is CLI, not HTTP.

Target command:

npm run import -- "<url>"

Debugging: append --dry-run to extract and print Recipe JSON without
touching AnyList.

npm run import -- "<url>" --dry-run

Eventually the target result is:

✓ Chicken Tinga saved to AnyList

## Development Sequence

Build in this order:

1. URL → normalized Recipe JSON
2. Recipe JSON → AnyList
3. Add TikTok and Instagram reliability/fallbacks
4. Add HTTP API
5. Add iPhone Shortcut
6. Add video/frame analysis only when caption + transcript are insufficient

Do not skip ahead unless explicitly asked.

## Engineering Principles

- TypeScript only.
- Prefer simple implementations over premature infrastructure.
- Do not build a database in the initial milestone.
- Do not build the HTTP API in the initial milestone.
- Do not build the iOS Shortcut in the initial milestone.
- Social-media extraction must be behind an adapter.
- AnyList integration must be behind an adapter.
- Never commit credentials, API keys, passwords, cookies, tokens, or session data.
- Never log secrets.
- Keep .env out of Git.
- Preserve the original Instagram or TikTok URL.
- Preserve the source creator when available.
- Do not invent recipe quantities, temperatures, times, or servings.
- Missing information should remain missing or generate a warning.
- Prefer deterministic parsing and validation around AI-generated structured output.
- Use Zod for external and AI-generated data validation.

## Initial Recipe Model

A recipe should support:

- title
- description optional
- servings optional
- prepTime optional
- cookTime optional
- ingredients
- instructions
- source
- confidence
- warnings

An ingredient should distinguish:

- quantity
- unit
- name
- preparation
- rawText

prepTime and cookTime use a shared TimeRange shape:

- minMinutes
- maxMinutes optional

A single stated duration sets minMinutes with maxMinutes null.
A stated range sets both. An exact time is never encoded as min equal to max.
Populate these only when the source explicitly states the duration; never sum
step durations into a total.

Source should include:

- platform
- creator optional
- url

## Initial Milestone

The first milestone is CLI only.

Command:

npm run import -- "<instagram-or-tiktok-url>"

Pipeline:

URL
→ identify platform
→ extract source text
→ parse structured recipe
→ validate with Zod
→ print normalized Recipe JSON

Do not connect AnyList until this pipeline works.

## Local HTTP API

Milestone 3 exposes the same import pipeline over HTTP for a future iPhone
Shortcut. Local only; not deployed.

npm run server       start on 127.0.0.1:3000
npm run server:dev   same, with reload

GET  /health      unauthenticated; proves the process is alive and nothing else
POST /api/import  requires Authorization: Bearer <RECIPE_API_KEY>

The CLI and the API both call importRecipe() in src/app/import-service.ts.
Neither reimplements the pipeline. buildServer() is separate from listen()
so tests never open a port.

The server refuses to start when RECIPE_API_KEY is missing or empty.

### Retry and duplicate risk

The API is synchronous and has no idempotency. A request runs source
extraction, a Claude call, and an AnyList save-and-verify, so it can take tens
of seconds. If a client times out and retries, the first request may still
complete and AnyList will hold two copies of the recipe. Duplicate detection is
deliberately not implemented. Decide retry behaviour when designing the
Shortcut.

## Known Issues

@anylist-napi/anylist-napi persists prepTime and cookTime as 0 (upstream bug).
The mapping still sends minMinutes so a future upstream fix benefits us
automatically, and every explicitly stated time is also written into the
recipe note so the information is never lost.

The package ships a prebuilt native binary and has one published version
from a single maintainer. It has no runtime JS dependencies and no known
advisories, but the binary itself cannot be audited by npm. Accepted for this
private single-user proof of concept; revisit before broader deployment or
multi-user use.

## Working Style

Before making significant architectural changes:

1. Inspect the existing repository.
2. Explain the proposed approach.
3. Keep changes narrowly scoped to the current milestone.
4. Run typecheck and tests after implementation.
5. Report what changed and any unresolved issues.

Do not add dependencies unless they are actually needed.
