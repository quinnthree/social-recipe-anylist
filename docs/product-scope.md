# Product Scope

Status: frozen for V1. Changes require explicit approval.
Last updated: 2026-08-21.

## V1 promise

> Save recipes from TikTok, Instagram, and YouTube directly to AnyList.

One sentence, one job. A user finds a recipe video, shares it, reviews what we
extracted, and it lands in their AnyList account. Success is measured by
recipes that arrive in AnyList correctly — not by anything that happens inside
our product.

We are **AnyList-first**. AnyList is the destination the product is built
around and the only export target in V1.

## Target flow

```
Social recipe → Share → backend extraction → canonical Recipe
              → Review/Edit → Save to AnyList
```

Review/Edit is a product requirement, not a nicety. Extraction from a caption
is lossy and sometimes wrong; the user is the correction step. This is why
extraction and export are separate operations in the production API.

## In scope for V1

- **Sources**: TikTok, Instagram, YouTube

  | Platform | Canonical support | Ingestion |
  |---|---|---|
  | TikTok | yes | **implemented** |
  | Instagram | yes | **implemented**, with current metadata limitations |
  | YouTube | yes | **not yet implemented** |

  "Canonical support" means the platform is a valid value in the canonical
  Recipe contract. "Ingestion" means we can actually fetch and extract from it.
  YouTube is in the V1 promise and is not yet buildable — that gap is real and
  tracked, not hidden.
- **Extraction**: source URL → canonical Recipe, with confidence and warnings
- **Review/Edit**: the user inspects and corrects the extracted recipe before
  anything is written to AnyList
- **Export**: verified save to AnyList, confirmed server-side before success is
  reported

## Explicitly out of scope

None of the following are V1 features. Proposals to add them require a scope
change, not a ticket.

- **Meal planning** — calendars, weekly plans, scheduling
- **Grocery system** — shopping lists, list management, store or aisle logic
- **Recipe library** — our own storage, browsing, search, collections,
  folders, tags, or favourites
- **Nutrition platform** — macros, calories, dietary analysis or scoring
- **Pantry** — inventory, stock tracking, "what can I make"
- **A ReciMe clone** — we are not building a general recipe-management
  application

Every one of these is something AnyList already does, or something that turns
this into a different product. AnyList owns the recipe after export. We own
getting it there.

## V1 acceptance bar: the minimum usable recipe

An extraction succeeds only if it produced something a person could actually
cook from. Deterministically:

- a non-blank **title**, and
- at least one **ingredient**, and
- at least one **instruction**

Anything less is an extraction failure, not a low-quality success. This is a
structural rule, **not** a confidence threshold — QA established that current
`confidence` does not correlate reliably enough with whether edits are needed
to serve as an acceptance gate (ADR-019).

`confidence` and `warnings` remain extraction-time assessment. They do not
decide this rule, and a recipe carrying warnings is still a normal, exportable
recipe.

## No Undo

Programmatic deletion in AnyList is unreliable — `deleteRecipe()` has been
observed returning success without removing the recipe (ADR-021). V1 therefore
offers **no Undo and no automatic rollback** of an export. Correction happens in
AnyList itself.

This is a product consequence of a measured platform limitation, and it is the
main reason export idempotency matters: a duplicate we create cannot be cleaned
up for the user.

## What this means in practice

- We do not need a recipe database to ship V1. The canonical Recipe is a
  payload in flight, not a stored entity.
- We do not build features that make a user want to stay in our app.
- If a feature does not make "social recipe lands in AnyList correctly" more
  likely, it is out.
