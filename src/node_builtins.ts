import { builtinModules } from "module";
import * as fs from "fs";
import * as Path from "path";
import { packageNameToModuleName } from "./uri_helpers";

export interface BuiltinModule {
    moduleName: string;
    importPath: string;
}

const BUILTINS_BY_PREFIX: Record<string, BuiltinModule[]> = {};
for (const name of builtinModules) {
    if (name.startsWith("_")) continue;
    const moduleName = packageNameToModuleName(name);
    const importPath = `node:${name}`;
    const prefix = moduleName.substring(0, 1);
    BUILTINS_BY_PREFIX[prefix] ??= [];
    BUILTINS_BY_PREFIX[prefix].push({ moduleName, importPath });
}

export function hasNodeTypes(workspaceRootFsPath: string): boolean {
    const atTypesNode = Path.join(workspaceRootFsPath, "node_modules", "@types", "node");
    return fs.existsSync(atTypesNode);
}

export function getNodeBuiltinsByPrefix(prefix: string): ReadonlyArray<BuiltinModule> {
    return BUILTINS_BY_PREFIX[prefix] ?? [];
}
