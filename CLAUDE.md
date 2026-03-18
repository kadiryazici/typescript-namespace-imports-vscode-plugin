# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project Overview

A VS Code extension that autocompletes TypeScript/JavaScript namespace imports (`import * as Name from "..."`). Suggests PascalCase module names from workspace files, npm packages, and Node.js built-in modules, inserting the import statement automatically.

Forked from [echentw/typescript-namespace-imports-vscode-plugin](https://github.com/echentw/typescript-namespace-imports-vscode-plugin) and rewritten with a new architecture.

## Development Commands

- `npm run build` — Build with source maps (esbuild)
- `npm run watch` — Build + watch
- `npm run tsc-build` — Type check only
- `npm run tsc-watch` — Type check + watch
- `npm run lint` — ESLint
- `npm run build-and-install` — Build, package .vsix, install into VS Code
- `npm run vscode:prepublish` — Production build with minification

## Architecture

### File Overview

| File | Purpose |
|------|---------|
| `src/extension.ts` | Entry point. Registers watchers and completion providers. |
| `src/completion_items_cache.ts` | Interface for the cache service. |
| `src/completion_items_cache_impl.ts` | Core service: workspace indexing, caching, completions. |
| `src/uri_helpers.ts` | Import path resolution, module naming, completion item creation. |
| `src/node_builtins.ts` | Node.js built-in module discovery and `@types/node` detection. |

### Key Design Decisions

**Config parsing uses `tsconfck`, not TypeScript's compiler API.**
We use the `tsconfck` library to parse `tsconfig.json` files because it resolves `extends`, `references`, and produces a final merged config without needing to spin up a full `ts.Program`. This is significantly cheaper than `ts.parseJsonConfigFileContent` / `ts.createProgram`. We considered using TypeScript's language server (tsserver) for ambient module discovery (`declare module`), but there's no clean protocol request for "list all ambient modules", and `ts.createProgram` is too expensive for that. Instead, we use Node.js `module.builtinModules` for built-ins and gate it behind `@types/node` detection.

**First-character prefix indexing for fast lookup.**
All modules (workspace files, packages, builtins) are bucketed by the first character of their PascalCase name (e.g. `F` for `Fs`, `R` for `React`). When the user types a character, we only scan the matching bucket. This avoids iterating every module on every keystroke.

**Deferred completion item resolution.**
`provideCompletionItems` returns lightweight items (just name + sortText + data). The expensive work — building markdown documentation, computing the import edit, finding the insertion line — happens in `resolveCompletionItem` only when the user selects an item. This keeps the completion popup fast.

**Smart import insertion line.**
Imports are inserted after the last existing import statement. If there are no imports, they go after leading `//` comments and `"use strict"` directives, but before JSDoc/block comments (which are attached to the code below).

**Save-based file updates, not keystroke-based.**
The file system watcher ignores content changes (`onDidChange`). Instead, `onDidSaveTextDocument` triggers `updateFile`, which only re-reads the `// #NamespaceName:` comment. This avoids excessive I/O during editing.

**tsconfig watching uses `fs.watch` on resolved files.**
VS Code's `FileSystemWatcher` handles tsconfig create/delete (to discover new roots). But for content changes to existing tsconfigs (including files resolved via `extends` and `references`), we use individual `fs.watch` watchers on each resolved config file path. The `_syncConfigWatchers` method diffs the current set against the previous set on each refresh.

**Node.js built-in modules are gated on `@types/node`.**
`module.builtinModules` provides the list at runtime. But we only show these completions if `@types/node` exists in the workspace's `node_modules`, since without types the imports would be useless. This check is refreshed when `package.json` changes.

**Package completions include sub-path exports.**
For each dependency, we read its `package.json` `exports` field and extract sub-path entries (e.g. `react-dom/client`). Wildcard patterns and internal paths (`./package.json`) are skipped. The `exports` value is recursively checked to confirm it resolves to a JS/TS file.

### Completion Sources (in order of evaluation)

1. **Workspace files** — `.ts`, `.tsx`, `.js`, `.jsx` files indexed on workspace init
2. **npm packages** — dependencies/devDependencies/peerDependencies from nearest `package.json`
3. **Node.js built-ins** — `fs`, `path`, `http`, etc. via `node:` prefix (if `@types/node` present)

All three are filtered against already-imported paths to avoid duplicates.

### Custom Namespace Names

Two mechanisms to override auto-generated PascalCase names:

1. **`// #NamespaceName: MyName`** comment in the first 10 lines of a file (512 bytes read via `fs.promises.open` for efficiency)
2. **`namespaceNameAliases`** field in `package.json` — maps package import paths to custom names. The extension also provides autocomplete for keys inside this field.

### Import Path Resolution

Respects VS Code's `typescript.preferences.importModuleSpecifier` setting:

- `shortest` (default) — picks shortest among relative, project-relative, and alias paths
- `relative` — always `./foo` or `../foo`
- `project-relative` — from workspace root
- `non-relative` — uses path alias if available, falls back to relative

Path aliases are extracted from `compilerOptions.paths` in tsconfig (only `prefix/*` → `target/*` patterns).

## Extension Configuration

- Activates on `typescript`, `typescriptreact`, `javascript`, `javascriptreact`
- Requires VS Code ^1.67.0
- Respects `typescript.preferences.importModuleSpecifier` setting
- No extension-specific settings (the upstream `quoteStyle` setting was removed in the rewrite)
