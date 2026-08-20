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
- prepTimeMinutes optional
- cookTimeMinutes optional
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

## Working Style

Before making significant architectural changes:

1. Inspect the existing repository.
2. Explain the proposed approach.
3. Keep changes narrowly scoped to the current milestone.
4. Run typecheck and tests after implementation.
5. Report what changed and any unresolved issues.

Do not add dependencies unless they are actually needed.
