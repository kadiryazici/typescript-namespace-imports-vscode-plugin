import * as Path from "path";
import { minimatch } from "minimatch";

export interface TsConfigScope {
    tsconfigDir: string;
    isMatch: (absolutePath: string) => boolean;
}

function normalizePattern(pattern: string): string {
    if (!pattern.includes("*") && !pattern.includes("?") && !Path.extname(pattern)) {
        return pattern.endsWith("/") ? pattern + "**/*" : pattern + "/**/*";
    }
    return pattern;
}

export function buildScope(
    tsconfigDir: string,
    include: string[] | undefined,
    exclude: string[] | undefined,
    outDir: string | undefined,
): TsConfigScope {
    const includeGlobs = (include ?? ["**/*"]).map(p =>
        Path.resolve(tsconfigDir, normalizePattern(p))
    );

    const excludeGlobs = ["**/node_modules/**"];
    for (const p of exclude ?? []) {
        excludeGlobs.push(Path.resolve(tsconfigDir, normalizePattern(p)));
    }
    if (outDir) {
        excludeGlobs.push(Path.resolve(tsconfigDir, outDir) + "/**/*");
    }

    return {
        tsconfigDir,
        isMatch(absolutePath: string): boolean {
            const included = includeGlobs.some(g => minimatch(absolutePath, g));
            if (!included) return false;
            return !excludeGlobs.some(g => minimatch(absolutePath, g));
        },
    };
}

export function findScope(absolutePath: string, scopes: TsConfigScope[]): TsConfigScope | undefined {
    let best: TsConfigScope | undefined;
    for (const scope of scopes) {
        if (!scope.isMatch(absolutePath)) continue;
        if (!best || scope.tsconfigDir.length > best.tsconfigDir.length) {
            best = scope;
        }
    }
    return best;
}
