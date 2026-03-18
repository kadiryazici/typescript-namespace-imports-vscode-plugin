# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A VS Code extension that provides autocomplete for TypeScript/JavaScript namespace imports (`import * as Name from "..."`). Suggests PascalCase module names from workspace files and npm packages, inserting the import statement automatically.

## Development Commands

### Build and Watch

- `npm run build` - Build with source maps using esbuild
- `npm run watch` - Build with source maps and watch for changes
- `npm run vscode:prepublish` - Production build with minification for publishing
- `npm run build-and-install` - Build, package as .vsix, and install into VS Code (for local testing)

### Type Checking

- `npm run tsc-build` - Run TypeScript compiler (type checking only)
- `npm run tsc-watch` - Run TypeScript compiler in watch mode

### Linting

- `npm run lint` - Run ESLint on TypeScript files

## Architecture

### Core Components

**Extension Entry Point (`src/extension.ts`)**

- Activates on TypeScript, TypeScript React, JavaScript, and JavaScript React files
- Sets up file system watchers for source files, `tsconfig.json`, and `package.json`
- Registers completion providers for source files and `package.json` (for `namespaceNameAliases` key autocomplete)

**Completion Items Cache (`src/completion_items_cache_impl.ts`)**

- Main service managing workspace-level caching of modules
- Maintains maps of available modules organized by first character for fast prefix lookup
- Handles workspace changes and file system events
- Parses `tsconfig.json` files (including references) to resolve path aliases
- Reads npm package dependencies and their sub-path exports from `package.json`
- Supports custom namespace names via `// #NamespaceName:` comments and `namespaceNameAliases` in `package.json`
- Uses `fs.watch` on resolved tsconfig files (roots + references) for live alias updates

**URI Helpers (`src/uri_helpers.ts`)**

- Resolves import paths based on `importModuleSpecifier` setting (shortest, relative, non-relative, project-relative)
- Handles TypeScript path mapping resolution
- Creates VS Code completion items with deferred resolution (documentation + import edit built on selection)
- Converts file/package names to PascalCase module names
- Smart import placement: after existing imports, or after leading comments if no imports exist

**Cache Interface (`src/completion_items_cache.ts`)**

- Interface definition for the completion items cache

### Key Features

- **Multi-language support**: TypeScript, TypeScript React, JavaScript, JavaScript React
- **Package imports**: Reads dependencies from `package.json` and suggests them as namespace imports
- **Sub-path exports**: Parses `exports` field from dependency package.json files
- **Custom names**: `// #NamespaceName:` in files, `namespaceNameAliases` in `package.json`
- **Path alias resolution**: Supports `paths` from `tsconfig.json` including referenced configs
- **First-character indexing**: Fast prefix-based lookup for completion suggestions
- **Deferred resolution**: `CompletionItem.resolve` builds documentation and import edits lazily
- **Config file watching**: Individual `fs.watch` watchers on resolved tsconfig files (roots + references)

## Extension Configuration

The extension activates on `typescript`, `typescriptreact`, `javascript`, and `javascriptreact` languages and requires VS Code ^1.67.0. It respects VS Code's `typescript.preferences.importModuleSpecifier` setting for path resolution.
