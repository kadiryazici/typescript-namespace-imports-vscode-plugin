import * as ts from "typescript";
import type { TSConfckParseResult } from "tsconfck";
import { packageNameToModuleName } from "./uri_helpers";

export interface AmbientModule {
    moduleName: string;
    importPath: string;
}

export class AmbientModulesResolver {
    private _byPrefix: Record<string, AmbientModule[]> = {};

    resolve(parseResults: TSConfckParseResult[]): void {
        // tsconfck already resolved extends/references — just extract compilerOptions
        const compilerOptions: ts.CompilerOptions = {};
        for (const result of parseResults) {
            const rawOptions = result.tsconfig?.compilerOptions;
            if (rawOptions) {
                Object.assign(compilerOptions, rawOptions);
            }
        }

        // Create a minimal program with no source files — just enough for the type checker
        // to discover ambient module declarations from lib/type roots
        const program = ts.createProgram([], compilerOptions);
        const checker = program.getTypeChecker();
        const ambientModules = checker.getAmbientModules();

        const byPrefix: Record<string, AmbientModule[]> = {};
        for (const symbol of ambientModules) {
            // Symbol name is quoted: "\"fs\"" → "fs"
            const importPath = symbol.getName().replace(/^"(.*)"$/, "$1");
            const moduleName = packageNameToModuleName(importPath);
            const prefix = moduleName.substring(0, 1);
            byPrefix[prefix] ??= [];
            byPrefix[prefix].push({ moduleName, importPath });
        }

        this._byPrefix = byPrefix;
    }

    getByPrefix(prefix: string): ReadonlyArray<AmbientModule> {
        return this._byPrefix[prefix] ?? [];
    }
}
