import * as vscode from "vscode";
import { uriToCompletionItem, uriToModuleName, uriToImportPath, resolveImportModuleSpecifier, PathAlias } from "./uri_helpers";
import * as Path from "path";
import * as fs from "fs";
import { parse as parseTsconfig, TSConfckParseResult } from "tsconfck";
import { CompletionItemsCache } from "./completion_items_cache";

interface Workspace {
    workspaceFolder: vscode.WorkspaceFolder;
    pathAliases: PathAlias[];
    configWatchers: Map<string, fs.FSWatcher>; // fsPath -> watcher for each resolved config file
    uriMap: Record<string, vscode.Uri[]>;
    customNames: Record<string, string>; // file path -> custom namespace name
    moduleNames: Map<string, string>; // uri.path -> cached uriToModuleName result
    prefixByPath: Map<string, string>; // uri.path -> current bucket prefix (reverse lookup)
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
    // Map from workspaceFolder.name -> cached workspace data
    private _cache: Record<string, Workspace> = {};

    constructor(workspaceFolders: readonly vscode.WorkspaceFolder[]) {
        workspaceFolders.forEach(this._addWorkspace);
    }

    handleWorkspaceChange = (event: vscode.WorkspaceFoldersChangeEvent): void => {
        event.added.forEach(this._addWorkspace);
        event.removed.forEach(this._removeWorkspace);
    };

    addFile = (uri: vscode.Uri) => {
        console.log(`[ns-imports] addFile: ${uri.path}`);
        const workspaceFolder = this._getWorkspaceFolderFromUri(uri);
        if (workspaceFolder) {
            const workspace = this._cache[workspaceFolder.name];

            if (workspace) {
                const moduleName = uriToModuleName(uri);
                workspace.moduleNames.set(uri.path, moduleName);
                const prefix = this._getPrefix(moduleName);
                workspace.uriMap[prefix] ??= [];
                workspace.uriMap[prefix].push(uri);
                workspace.prefixByPath.set(uri.path, prefix);
                this._readCustomName(uri).then(name => {
                    if (name) {
                        workspace.customNames[uri.path] = name;
                        this._rebucketUri(uri, name, workspace.uriMap, workspace.prefixByPath);
                    }
                });
            } else {
                console.error("Cannot add item: Workspace has not been cached");
            }
        }

        return;
    };

    deleteFile = (uri: vscode.Uri) => {
        console.log(`[ns-imports] deleteFile: ${uri.path}`);
        const workspaceFolder = this._getWorkspaceFolderFromUri(uri);
        if (workspaceFolder) {
            const workspace = this._cache[workspaceFolder.name];

            if (workspace) {
                const prefix = workspace.prefixByPath.get(uri.path);
                if (prefix && workspace.uriMap[prefix]) {
                    workspace.uriMap[prefix] = workspace.uriMap[prefix].filter(
                        u => u.path !== uri.path
                    );
                }
                workspace.prefixByPath.delete(uri.path);
                workspace.moduleNames.delete(uri.path);
                delete workspace.customNames[uri.path];
            }
        }

        return;
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
        const specifier = resolveImportModuleSpecifier(currentUri);
        const workspacePath = workspaceFolder.uri.path;
        const uris = workspace.uriMap[this._getPrefix(query)] ?? [];
        const items: vscode.CompletionItem[] = [];
        for (const uri of uris) {
            const importPath = uriToImportPath(uri, currentUri, workspace.pathAliases, specifier, workspacePath);
            if (importedPaths.has(importPath)) continue;
            const moduleName = workspace.customNames[uri.path] ?? workspace.moduleNames.get(uri.path) ?? uriToModuleName(uri);
            items.push(uriToCompletionItem(moduleName, importPath));
        }

        console.log(`[ns-imports] getCompletionList: query="${query}", candidates=${uris.length}, results=${items.length}`);
        return new vscode.CompletionList(items, false);
    };

    private _removeWorkspace = (workspaceFolder: vscode.WorkspaceFolder): void => {
        const workspace = this._cache[workspaceFolder.name];
        if (workspace) {
            for (const watcher of workspace.configWatchers.values()) {
                watcher.close();
            }
        }
        delete this._cache[workspaceFolder.name];
    };

    private _addWorkspace = (workspaceFolder: vscode.WorkspaceFolder): void => {
        console.log(`[ns-imports] _addWorkspace: "${workspaceFolder.name}"`);
        const typescriptPattern = new vscode.RelativePattern(workspaceFolder, "**/*.{ts,tsx,js,jsx}");
        this._getWorkspacePathAliases(workspaceFolder).then(({ aliases, configFiles }) => {
            vscode.workspace.findFiles(typescriptPattern).then(
                uris => {
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
                    this._cache[workspaceFolder.name] = { workspaceFolder, pathAliases: aliases, configWatchers, uriMap, customNames, moduleNames, prefixByPath };
                    this._syncConfigWatchers(this._cache[workspaceFolder.name], configFiles);
                    console.log(`[ns-imports] _addWorkspace "${workspaceFolder.name}": indexed ${uris.length} files`);
                    const uriByPath = new Map(uris.map(u => [u.path, u]));
                    this._readCustomNamesBatched(uris, 64).then(nameMap => {
                        for (const [path, name] of nameMap) {
                            customNames[path] = name;
                            const uri = uriByPath.get(path);
                            if (uri) this._rebucketUri(uri, name, uriMap, prefixByPath);
                        }
                        console.log(`[ns-imports] _addWorkspace "${workspaceFolder.name}": custom names resolved, ${nameMap.size} custom names found`);
                    });
                },
                error => {
                    console.error(`Error creating cache: ${error}`);
                }
            );
        });
    };

    refreshPathAliases = (tsconfigUri: vscode.Uri) => {
        const workspaceFolder = this._getWorkspaceFolderFromUri(tsconfigUri);
        if (!workspaceFolder) return;
        const workspace = this._cache[workspaceFolder.name];
        if (!workspace) return;
        console.log(`[ns-imports] refreshPathAliases: tsconfig changed at ${tsconfigUri.path}`);
        this._getWorkspacePathAliases(workspaceFolder).then(({ aliases, configFiles }) => {
            workspace.pathAliases = aliases;
            this._syncConfigWatchers(workspace, configFiles);
            console.log(`[ns-imports] refreshPathAliases: resolved ${aliases.length} aliases, watching ${configFiles.length} config files`);
        });
    };

    private _syncConfigWatchers = (workspace: Workspace, configFiles: string[]): void => {
        const newSet = new Set(configFiles);

        // Remove watchers for files no longer referenced
        for (const [fsPath, watcher] of workspace.configWatchers) {
            if (!newSet.has(fsPath)) {
                watcher.close();
                workspace.configWatchers.delete(fsPath);
            }
        }

        // Add watchers for newly discovered config files
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

    updateFile = (uri: vscode.Uri) => {
        console.log(`[ns-imports] updateFile: ${uri.path}`);
        const workspaceFolder = this._getWorkspaceFolderFromUri(uri);
        if (!workspaceFolder) return;
        const workspace = this._cache[workspaceFolder.name];
        if (!workspace) return;
        this._readCustomName(uri).then(name => {
            const oldName = workspace.customNames[uri.path];
            if (name === oldName) return; // no change, skip re-bucketing

            // Remove from current bucket via reverse lookup
            const oldPrefix = workspace.prefixByPath.get(uri.path);
            if (oldPrefix && workspace.uriMap[oldPrefix]) {
                const bucket = workspace.uriMap[oldPrefix];
                const idx = bucket.findIndex(u => u.path === uri.path);
                if (idx !== -1) bucket.splice(idx, 1);
            }
            // Re-add to the correct bucket
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
        });
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

    private _readCustomName = (uri: vscode.Uri): Promise<string | undefined> => {
        return new Promise(resolve => {
            const buf = Buffer.alloc(512);
            fs.open(uri.fsPath, "r", (err, fd) => {
                if (err) return resolve(undefined);
                fs.read(fd, buf, 0, 512, 0, (err2, bytesRead) => {
                    // eslint-disable-next-line @typescript-eslint/no-empty-function
                    fs.close(fd, () => { /* noop */ });
                    if (err2) return resolve(undefined);
                    const text = buf.toString("utf-8", 0, bytesRead);
                    const lines = text.split("\n");
                    for (let i = 0; i < Math.min(10, lines.length); i++) {
                        const match = lines[i].match(/\/\/ #NamespaceName:\s*(\w+)/);
                        if (match) return resolve(match[1]);
                    }
                    resolve(undefined);
                });
            });
        });
    };

    private _getWorkspacePathAliases = (
        workspaceFolder: vscode.WorkspaceFolder
    ): Thenable<{ aliases: PathAlias[]; configFiles: string[] }> => {
        const tsconfigPattern = new vscode.RelativePattern(workspaceFolder, "**/tsconfig.json");

        return vscode.workspace.findFiles(tsconfigPattern, "**/node_modules/**").then(
            uris =>
                Promise.all(
                    uris.map(tsconfigUri =>
                        parseTsconfig(tsconfigUri.fsPath).then(
                            result => {
                                const allConfigs = [result, ...(result.referenced ?? [])];
                                const aliases = allConfigs.flatMap((r: TSConfckParseResult) =>
                                    this._extractPathAliases(r.tsconfig, r.tsconfigFile, workspaceFolder)
                                );
                                const configFiles = allConfigs.map((r: TSConfckParseResult) => r.tsconfigFile);
                                return { aliases, configFiles };
                            },
                            error => {
                                console.error(`Error parsing ${tsconfigUri.path}: ${error}`);
                                return { aliases: [] as PathAlias[], configFiles: [] as string[] };
                            }
                        )
                    )
                ).then(results => ({
                    aliases: results.flatMap(r => r.aliases),
                    configFiles: results.flatMap(r => r.configFiles),
                })),
            error => {
                console.error(`Error while finding tsconfig.json files: ${error}`);
                return { aliases: [], configFiles: [] };
            }
        );
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

    private _getPrefix = (query: string): string => query.substring(0, 1);

    private _getWorkspaceFolderFromUri = (uri: vscode.Uri): vscode.WorkspaceFolder | undefined => {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);

        if (workspaceFolder === undefined) {
            console.error("URI in undefined workspaceFolder", uri);
        }

        return workspaceFolder;
    };
}
