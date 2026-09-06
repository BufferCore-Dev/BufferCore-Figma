# BufferCore Figma

BufferCore-Figma adapts the canonical BufferCore Engine manifest into a Figma-specific desired-state manifest and provides the Figma-side importer/sync client.

## Pipeline

```text
BufferCore SCSS
    ↓
BufferCore-Engine
    ↓
canonical BufferCore manifest
    ↓
BufferCore-Figma adapter
    ↓
generated/figma/buffercore.figma.json
    ↓
Figma plugin inspect → diff → apply
```

The plugin consumes the generic Figma manifest. It must not contain a static list of current BufferCore token names.

## Commands

From `BufferCore-Engine` first generate the canonical source:

```text
npm run core:build
```

Then in this repository:

```text
npm install
npm test
npm run figma:build
npm run plugin:build
```

The development plugin is loaded into Figma from:

```text
plugin/manifest.json
```

The generated BufferCore Figma manifest is:

```text
generated/figma/buffercore.figma.json
```

Use that JSON file in the plugin's **Choose manifest** control, inspect the proposed diff, and then apply it.

## Batch 4 scope

The first plugin core supports:

- local collection inspection;
- local variable inspection;
- Text Style and Effect Style inspection;
- generic flattening of BufferCore mode dimensions into Figma collection modes;
- create/update planning by BufferCore canonical identity;
- collection creation/update;
- variable creation/update;
- literal and alias values;
- scopes;
- Text Style creation/binding;
- materialised Effect Style creation;
- a structured inspect/diff/apply UI with separate import/update totals for Semantic variables, Primitive variables, Styles and Collections;
- import/update filtering and manifest/warning status.

Stable binding hardening, conflict policy, deletion/orphan handling and repeat-sync safety remain the next batch. Semantic layered Shadow recipes are now materialised as real Figma Effect Styles from the canonical resolved recipe; unresolved recipes fail softly with a targeted warning instead of creating empty styles.

## Figma collection layout

The generated manifest creates Foundation-specific collections in this intended order:

1. `Semantic: <Foundation>` collections
2. one empty visual divider collection (`────────────────────`)
3. `Primitive: <Foundation>` collections

Figma exposes no collection-reorder method in the Plugin API. The adapter therefore carries a separate `figmaName` with leading-space sort metadata while retaining the clean BufferCore `name` for presentation and diff UI. This forces the Local Variables authoring list into the intended Semantic → divider → Primitive sequence without adding visible numeric prefixes. Primitive collections remain hidden from publishing and the divider contains no variables.

Number tokens whose canonical path contains `opacity` receive Figma's `OPACITY` scope so they can be bound to supported opacity properties.

## Stable bindings and repeat sync

The Figma plugin persists BufferCore canonical IDs on collections, variables and styles, plus a document-level canonical-to-Figma binding registry. After a successful apply it records both the desired BufferCore signature and the live Figma signature for each managed object.

On later inspections the plugin distinguishes clean source updates from Figma-only drift and true conflicts. Drift/conflicts block apply rather than silently overwriting manual Figma edits. Managed objects missing from the current manifest are surfaced as orphaned and are preserved unless the manifest explicitly marks them retired.

## Flavours

`BufferCore-Figma` consumes the already-resolved Engine manifest. It does not implement a second Flavour system or duplicate overrides.

When Engine is built with `--flavour <id>`, the Figma manifest carries that Flavour provenance and translates the resolved Primitive values while retaining the same canonical Semantic aliases and Figma identities. Switching Flavour therefore produces value updates rather than a second variable architecture.

## Repository sync

The manual manifest picker remains available as a development fallback, but repository-backed builds can now be prepared with the Git pull workflow:

```powershell
npm run repo:sync
npm run repo:sync -- --flavour my-flavour
```

The sync command uses the sibling `BufferCore` and `BufferCore-Flavours` repositories by default. It refuses to pull repositories with uncommitted changes, fetches and fast-forward-pulls the configured branch, records repository/commit provenance, resolves the selected Flavour through Engine, and generates the Figma manifest.

Useful options:

```text
--core <path>
--flavours <path>
--core-branch <branch>
--flavours-branch <branch>
--core-remote <remote>
--flavours-remote <remote>
--flavour <id-or-path>
--no-pull
--allow-dirty
```

`--allow-dirty` should be used only deliberately; the default refusal protects local source work from an automated pull.

## Repository sync in the development plugin

Run `npm run repo:bridge` while using the local development plugin. The plugin can then show the current Core/Flavours branch and commit, select a Flavour, run the existing safe fast-forward repository sync, rebuild Engine/Figma state, load the resulting manifest, inspect the diff, and apply it. Manual manifest import remains available as a fallback. The bridge listens only on `127.0.0.1:3847`; the development plugin manifest permits only that local endpoint.
