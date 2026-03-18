import * as vscode from "vscode";
import { uriToCompletionItem, uriToModuleName, uriToImportPath, getImportModuleSpecifier, packageNameToModuleName, PathAlias } from "./uri_helpers";
import * as Path from "path";
import * as fs from "fs";
import { parse as parseTsconfig, TSConfckParseResult } from "tsconfck";
import { CompletionItemsCache } from "./completion_items_cache";

interface PackageEntry {
    moduleName: string;
    packageName: string;
}

interface PackageJsonCache {
    entries: PackageEntry[];
    byPrefix: Record<string, PackageEntry[]>;
}

interface Workspace {
    workspaceFolder: vscode.WorkspaceFolder;
    pathAliases: PathAlias[];
    configWatchers: Map<string, fs.FSWatcher>;
    packageJsonCache: Map<string, PackageJsonCache>; // package.json fsPath -> cached entries
    uriMap: Record<string, vscode.Uri[]>;
    customNames: Record<string, string>;
    moduleNames: Map<string, string>;
    prefixByPath: Map<string, string>;
}

/**
 * Creates a cache of module URIs backed by a map that is split by the first character
 * of each module name. Completion items are generated at query time so that import paths
 * are computed relative to the current document.
 *
 * TODO: Using this map makes intellisense quick even in large projects, but a more elegant
 * solution might be to implement some type of trie tree for CompletionItems
 */
export class CompletionItemsCacheImpl implements CompletionItemsCache {
    private _cache: Record<string, Workspace> = {};

    constructor(workspaceFolders: readonly vscode.WorkspaceFolder[]) {
        workspaceFolders.forEach(this._addWorkspace);
    }

    handleWorkspaceChange = (event: vscode.WorkspaceFoldersChangeEvent): void => {
        event.added.forEach(this._addWorkspace);
        event.removed.forEach(this._removeWorkspace);
    };

    addFile = async (uri: vscode.Uri) => {
        console.log(`[ns-imports] addFile: ${uri.path}`);
        const workspaceFolder = this._getWorkspaceFolderFromUri(uri);
        if (!workspaceFolder) return;

        const workspace = this._cache[workspaceFolder.name];
        if (!workspace) {
            console.error("Cannot add item: Workspace has not been cached");
            return;
        }

        const moduleName = uriToModuleName(uri);
        workspace.moduleNames.set(uri.path, moduleName);
        const prefix = this._getPrefix(moduleName);
        workspace.uriMap[prefix] ??= [];
        workspace.uriMap[prefix].push(uri);
        workspace.prefixByPath.set(uri.path, prefix);

        const name = await this._readCustomName(uri);
        if (name) {
            workspace.customNames[uri.path] = name;
            this._rebucketUri(uri, name, workspace.uriMap, workspace.prefixByPath);
        }
    };

    deleteFile = (uri: vscode.Uri) => {
        console.log(`[ns-imports] deleteFile: ${uri.path}`);
        const workspaceFolder = this._getWorkspaceFolderFromUri(uri);
        if (!workspaceFolder) return;

        const workspace = this._cache[workspaceFolder.name];
        if (!workspace) return;

        const prefix = workspace.prefixByPath.get(uri.path);
        if (prefix && workspace.uriMap[prefix]) {
            workspace.uriMap[prefix] = workspace.uriMap[prefix].filter(
                u => u.path !== uri.path
            );
        }
        workspace.prefixByPath.delete(uri.path);
        workspace.moduleNames.delete(uri.path);
        delete workspace.customNames[uri.path];
    };

    getCompletionList = (doc: vscode.TextDocument, query: string): vscode.CompletionList | [] => {
        const currentUri = doc.uri;
        const workspaceFolder = this._getWorkspaceFolderFromUri(currentUri);

        if (!workspaceFolder) {
            return [];
        }

        const workspace = this._cache[workspaceFolder.name];

        if (!workspace) {
            console.warn("Workspace was not in cache");
            return [];
        }

        const docText = doc.getText();
        const importedPaths = new Set(
            [...docText.matchAll(/from\s+["']([^"']+)["']/g)].map(m => m[1])
        );
        const specifier = getImportModuleSpecifier(currentUri);
        const workspacePath = workspaceFolder.uri.path;
        const prefix = this._getPrefix(query);
        const uris = workspace.uriMap[prefix] ?? [];
        const items: vscode.CompletionItem[] = [];
        for (const uri of uris) {
            const importPath = uriToImportPath(uri, currentUri, workspace.pathAliases, specifier, workspacePath);
            if (importedPaths.has(importPath)) continue;
            const moduleName = workspace.customNames[uri.path] ?? workspace.moduleNames.get(uri.path) ?? uriToModuleName(uri);
            items.push(uriToCompletionItem(moduleName, importPath, `namespace: ${importPath}`));
        }

        // Add package entries from nearest package.json
        const pkgData = this._getPackageEntries(currentUri, workspace);
        if (pkgData) {
            const pkgEntries = pkgData.byPrefix[prefix] ?? [];
            for (const { moduleName, packageName } of pkgEntries) {
                if (importedPaths.has(packageName)) continue;
                items.push(uriToCompletionItem(moduleName, packageName, `namespace: ${packageName}`));
            }
        }

        console.log(`[ns-imports] getCompletionList: query="${query}", candidates=${uris.length}, results=${items.length}`);
        return new vscode.CompletionList(items, false);
    };

    private _removeWorkspace = (workspaceFolder: vscode.WorkspaceFolder): void => {
        const workspace = this._cache[workspaceFolder.name];
        if (!workspace) return;

        for (const watcher of workspace.configWatchers.values()) {
            watcher.close();
        }
        delete this._cache[workspaceFolder.name];
    };

    private _addWorkspace = async (workspaceFolder: vscode.WorkspaceFolder) => {
        console.log(`[ns-imports] _addWorkspace: "${workspaceFolder.name}"`);
        const typescriptPattern = new vscode.RelativePattern(workspaceFolder, "**/*.{ts,tsx,js,jsx}");

        const [{ aliases, configFiles }, uris] = await Promise.all([
            this._getWorkspacePathAliases(workspaceFolder),
            vscode.workspace.findFiles(typescriptPattern, "**/node_modules/**").then(undefined, error => {
                console.error(`Error creating cache: ${error}`);
                return [] as vscode.Uri[];
            }),
        ]);

        const uriMap: Record<string, vscode.Uri[]> = {};
        const prefixByPath = new Map<string, string>();
        const moduleNames = new Map<string, string>();
        for (const uri of uris) {
            const moduleName = uriToModuleName(uri);
            moduleNames.set(uri.path, moduleName);
            const prefix = this._getPrefix(moduleName);
            uriMap[prefix] ??= [];
            uriMap[prefix].push(uri);
            prefixByPath.set(uri.path, prefix);
        }

        const customNames: Record<string, string> = {};
        const configWatchers = new Map<string, fs.FSWatcher>();
        const packageJsonCache = new Map<string, PackageJsonCache>();
        this._cache[workspaceFolder.name] = { workspaceFolder, pathAliases: aliases, configWatchers, packageJsonCache, uriMap, customNames, moduleNames, prefixByPath };
        this._syncConfigWatchers(this._cache[workspaceFolder.name], configFiles);
        console.log(`[ns-imports] _addWorkspace "${workspaceFolder.name}": indexed ${uris.length} files`);

        const uriByPath = new Map(uris.map(u => [u.path, u]));
        const nameMap = await this._readCustomNamesBatched(uris, 64);
        for (const [path, name] of nameMap) {
            customNames[path] = name;
            const uri = uriByPath.get(path);
            if (uri) this._rebucketUri(uri, name, uriMap, prefixByPath);
        }
        console.log(`[ns-imports] _addWorkspace "${workspaceFolder.name}": custom names resolved, ${nameMap.size} custom names found`);
    };

    refreshPathAliases = async (tsconfigUri: vscode.Uri) => {
        const workspaceFolder = this._getWorkspaceFolderFromUri(tsconfigUri);
        if (!workspaceFolder) return;
        const workspace = this._cache[workspaceFolder.name];
        if (!workspace) return;

        console.log(`[ns-imports] refreshPathAliases: tsconfig changed at ${tsconfigUri.path}`);
        const { aliases, configFiles } = await this._getWorkspacePathAliases(workspaceFolder);
        workspace.pathAliases = aliases;
        this._syncConfigWatchers(workspace, configFiles);
        console.log(`[ns-imports] refreshPathAliases: resolved ${aliases.length} aliases, watching ${configFiles.length} config files`);
    };

    private _syncConfigWatchers = (workspace: Workspace, configFiles: string[]): void => {
        const newSet = new Set(configFiles);

        for (const [fsPath, watcher] of workspace.configWatchers) {
            if (newSet.has(fsPath)) continue;
            watcher.close();
            workspace.configWatchers.delete(fsPath);
        }

        for (const fsPath of configFiles) {
            if (workspace.configWatchers.has(fsPath)) continue;
            try {
                const watcher = fs.watch(fsPath, () => {
                    console.log(`[ns-imports] config file changed: ${fsPath}`);
                    this.refreshPathAliases(vscode.Uri.file(fsPath));
                });
                workspace.configWatchers.set(fsPath, watcher);
            } catch {
                // File may have been deleted between discovery and watch
            }
        }
    };

    invalidatePackageJson = (uri: vscode.Uri) => {
        const workspaceFolder = this._getWorkspaceFolderFromUri(uri);
        if (!workspaceFolder) return;
        const workspace = this._cache[workspaceFolder.name];
        if (!workspace) return;
        workspace.packageJsonCache.delete(uri.fsPath);
        console.log(`[ns-imports] invalidatePackageJson: ${uri.path}`);
    };

    updateFile = async (uri: vscode.Uri) => {
        console.log(`[ns-imports] updateFile: ${uri.path}`);
        const workspaceFolder = this._getWorkspaceFolderFromUri(uri);
        if (!workspaceFolder) return;
        const workspace = this._cache[workspaceFolder.name];
        if (!workspace) return;

        const name = await this._readCustomName(uri);
        const oldName = workspace.customNames[uri.path];
        if (name === oldName) return; // no change, skip re-bucketing

        const oldPrefix = workspace.prefixByPath.get(uri.path);
        if (oldPrefix && workspace.uriMap[oldPrefix]) {
            const bucket = workspace.uriMap[oldPrefix];
            const idx = bucket.findIndex(u => u.path === uri.path);
            if (idx !== -1) bucket.splice(idx, 1);
        }

        const effectiveName = name ?? uriToModuleName(uri);
        const prefix = this._getPrefix(effectiveName);
        workspace.uriMap[prefix] ??= [];
        workspace.uriMap[prefix].push(uri);
        workspace.prefixByPath.set(uri.path, prefix);

        if (name) {
            workspace.customNames[uri.path] = name;
        } else {
            delete workspace.customNames[uri.path];
        }
    };

    private _rebucketUri = (uri: vscode.Uri, customName: string, uriMap: Record<string, vscode.Uri[]>, prefixByPath: Map<string, string>): void => {
        const oldPrefix = prefixByPath.get(uri.path);
        const customPrefix = this._getPrefix(customName);
        if (oldPrefix === customPrefix) return;
        if (oldPrefix && uriMap[oldPrefix]) {
            uriMap[oldPrefix] = uriMap[oldPrefix].filter(u => u.path !== uri.path);
        }
        uriMap[customPrefix] ??= [];
        uriMap[customPrefix].push(uri);
        prefixByPath.set(uri.path, customPrefix);
    };

    private _readCustomNamesBatched = async (uris: vscode.Uri[], batchSize: number): Promise<Map<string, string>> => {
        const result = new Map<string, string>();
        for (let i = 0; i < uris.length; i += batchSize) {
            const batch = uris.slice(i, i + batchSize);
            const names = await Promise.all(batch.map(uri => this._readCustomName(uri)));
            for (let j = 0; j < batch.length; j++) {
                const name = names[j];
                if (name) result.set(batch[j].path, name);
            }
        }
        return result;
    };

    private _readCustomName = async (uri: vscode.Uri): Promise<string | undefined> => {
        let fd: fs.promises.FileHandle | undefined;
        try {
            fd = await fs.promises.open(uri.fsPath, "r");
            const buf = Buffer.alloc(512);
            const { bytesRead } = await fd.read(buf, 0, 512, 0);
            const text = buf.toString("utf-8", 0, bytesRead);
            const lines = text.split("\n");
            for (let i = 0; i < Math.min(10, lines.length); i++) {
                const match = lines[i].match(/\/\/ #NamespaceName:\s*(\w+)/);
                if (match) return match[1];
            }
            return undefined;
        } catch {
            return undefined;
        } finally {
            await fd?.close();
        }
    };

    private _getWorkspacePathAliases = async (
        workspaceFolder: vscode.WorkspaceFolder
    ): Promise<{ aliases: PathAlias[]; configFiles: string[] }> => {
        const tsconfigPattern = new vscode.RelativePattern(workspaceFolder, "**/tsconfig.json");

        let uris: vscode.Uri[];
        try {
            uris = await vscode.workspace.findFiles(tsconfigPattern, "**/node_modules/**");
        } catch (error) {
            console.error(`Error while finding tsconfig.json files: ${error}`);
            return { aliases: [], configFiles: [] };
        }

        const results = await Promise.all(
            uris.map(async tsconfigUri => {
                try {
                    const result = await parseTsconfig(tsconfigUri.fsPath);
                    const allConfigs = [result, ...(result.referenced ?? [])];
                    const aliases = allConfigs.flatMap((r: TSConfckParseResult) =>
                        this._extractPathAliases(r.tsconfig, r.tsconfigFile, workspaceFolder)
                    );
                    const configFiles = allConfigs.map((r: TSConfckParseResult) => r.tsconfigFile);
                    return { aliases, configFiles };
                } catch (error) {
                    console.error(`Error parsing ${tsconfigUri.path}: ${error}`);
                    return { aliases: [] as PathAlias[], configFiles: [] as string[] };
                }
            })
        );

        return {
            aliases: results.flatMap(r => r.aliases),
            configFiles: results.flatMap(r => r.configFiles),
        };
    };

    private _extractPathAliases = (
        tsconfigObj: Record<string, unknown>,
        tsconfigFile: string,
        workspaceFolder: vscode.WorkspaceFolder
    ): PathAlias[] => {
        const compilerOptions = tsconfigObj?.compilerOptions as Record<string, unknown> | undefined;
        const paths = compilerOptions?.paths as Record<string, string[]> | undefined;
        if (!paths) return [];

        const tsconfigDirRelative = Path.relative(
            workspaceFolder.uri.path,
            Path.dirname(tsconfigFile)
        );

        const aliases: PathAlias[] = [];
        for (const pattern of Object.keys(paths)) {
            const targets: string[] = paths[pattern];
            if (!pattern.endsWith("/*") || targets.length === 0) continue;
            const aliasPrefix = pattern.slice(0, -1); // strip trailing "*"
            for (const target of targets) {
                if (!target.endsWith("/*")) continue;
                const targetSuffix = target.slice(0, -1); // strip trailing "*"
                const targetPrefix = Path.join(tsconfigDirRelative, targetSuffix);
                aliases.push({ targetPrefix, aliasPrefix });
                break; // use first valid target per pattern
            }
        }
        return aliases;
    };

    private _getPackageEntries = (currentUri: vscode.Uri, workspace: Workspace): PackageJsonCache | undefined => {
        const pkgJsonPath = this._findNearestPackageJson(currentUri.fsPath, workspace.workspaceFolder.uri.fsPath);
        if (!pkgJsonPath) return undefined;

        const cached = workspace.packageJsonCache.get(pkgJsonPath);
        if (cached) return cached;

        try {
            const content = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
            const deps = new Set<string>();
            for (const key of ["dependencies", "devDependencies", "peerDependencies"] as const) {
                const section = content[key];
                if (section && typeof section === "object") {
                    for (const name of Object.keys(section)) deps.add(name);
                }
            }

            const nameAliases = (content.namespaceNameAliases ?? {}) as Record<string, string>;
            const entries: PackageEntry[] = [];
            const byPrefix: Record<string, PackageEntry[]> = {};
            const addEntry = (moduleName: string, packageName: string) => {
                const entry: PackageEntry = { moduleName: nameAliases[packageName] ?? moduleName, packageName };
                entries.push(entry);
                const prefix = this._getPrefix(entry.moduleName);
                byPrefix[prefix] ??= [];
                byPrefix[prefix].push(entry);
            };

            const nodeModulesDir = Path.join(Path.dirname(pkgJsonPath), "node_modules");
            for (const packageName of deps) {
                addEntry(packageNameToModuleName(packageName), packageName);

                // Read sub-path exports from the dependency's package.json
                const depPkgPath = Path.join(nodeModulesDir, packageName, "package.json");
                try {
                    const depPkg = JSON.parse(fs.readFileSync(depPkgPath, "utf-8"));
                    const subPaths = this._extractSubPathExports(depPkg.exports);
                    for (const subPath of subPaths) {
                        const importPath = `${packageName}/${subPath}`;
                        addEntry(packageNameToModuleName(importPath), importPath);
                    }
                } catch {
                    // dependency package.json not readable, skip exports
                }
            }

            const result = { entries, byPrefix };
            workspace.packageJsonCache.set(pkgJsonPath, result);
            return result;
        } catch {
            return undefined;
        }
    };

    /** Extracts sub-path export keys (e.g. "react" from "./react") that point to JS files, skipping the main export. */
    private _extractSubPathExports = (exports: unknown): string[] => {
        if (!exports || typeof exports !== "object") return [];

        const result: string[] = [];
        for (const key of Object.keys(exports as Record<string, unknown>)) {
            // Skip main export and internal paths
            if (key === "." || key === "./package.json" || !key.startsWith("./")) continue;
            // Skip wildcard patterns
            if (key.includes("*")) continue;

            const subPath = key.slice(2); // strip "./"
            if (this._exportsValuePointsToJs((exports as Record<string, unknown>)[key])) {
                result.push(subPath);
            }
        }
        return result;
    };

    /** Recursively checks if an exports value eventually resolves to a .js/.mjs/.cjs file */
    private _exportsValuePointsToJs = (value: unknown): boolean => {
        if (typeof value === "string") {
            return /\.(js|mjs|cjs|ts|mts|cts)$/.test(value);
        }
        if (value && typeof value === "object") {
            // Conditional exports: { import: "...", require: "...", default: "..." }
            return Object.values(value as Record<string, unknown>).some(v => this._exportsValuePointsToJs(v));
        }
        return false;
    };

    private _findNearestPackageJson = (fileFsPath: string, workspaceRootFsPath: string): string | undefined => {
        let dir = Path.dirname(fileFsPath);
        while (dir.length >= workspaceRootFsPath.length) {
            const candidate = Path.join(dir, "package.json");
            if (fs.existsSync(candidate)) return candidate;
            const parent = Path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
        return undefined;
    };

    private _getPrefix = (query: string): string => query.substring(0, 1);

    private _getWorkspaceFolderFromUri = (uri: vscode.Uri): vscode.WorkspaceFolder | undefined => {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);

        if (workspaceFolder === undefined) {
            console.error("URI in undefined workspaceFolder", uri);
        }

        return workspaceFolder;
    };
}
