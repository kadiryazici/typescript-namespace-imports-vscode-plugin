# Typescript Namespace Imports

A VS Code extension that provides autocomplete for [namespace imports](http://exploringjs.com/es6/ch_modules.html#_importing-styles):

```typescript
import * as ModuleName from "path/to/module_name";
```

## Features

### Workspace File Imports

Every TypeScript and JavaScript file in your workspace is offered as a PascalCase namespace import.

- `module_name.ts` → `ModuleName`
- `my-component.tsx` → `MyComponent`
- `index.ts` inside `utils/` → `Utils`

As you type, matching module names appear in autocomplete. Selecting one inserts the import statement automatically.

### Package Imports

Dependencies from your `package.json` are also suggested as namespace imports:

- `react` → `React`
- `@seamapi/react` → `SeamapiReact`

Sub-path exports are supported too — if a package exposes `./react` in its `exports` field, you'll get a suggestion like `motion/react` → `MotionReact`.

### Custom Names via `// #NamespaceName:`

Add a comment to the top of any file to override the generated name:

```typescript
// #NamespaceName: MyCustomName
export function foo() {}
```

This file will appear as `MyCustomName` instead of the filename-derived name.

### Custom Names via `namespaceNameAliases` in `package.json`

Override namespace names for packages by adding a `namespaceNameAliases` field to your `package.json`:

```json
{
  "namespaceNameAliases": {
    "motion/react": "Motion",
    "@seamapi/react": "Seam"
  }
}
```

Autocomplete is provided for the keys — it suggests your dependencies and their sub-path exports.

### Path Resolution

The extension respects VS Code's `typescript.preferences.importModuleSpecifier` setting (and the `js/ts.preferences.importModuleSpecifier` fallback):

| Setting              | Behavior                                                            |
| -------------------- | ------------------------------------------------------------------- |
| `shortest` (default) | Picks the shortest path among relative, project-relative, and alias |
| `relative`           | Always uses `./` relative paths                                     |
| `non-relative`       | Uses path aliases if available, falls back to relative              |
| `project-relative`   | Uses paths relative to the workspace root                           |

TypeScript `paths` mappings from `tsconfig.json` (including referenced configs) are resolved and used for alias-based imports.
