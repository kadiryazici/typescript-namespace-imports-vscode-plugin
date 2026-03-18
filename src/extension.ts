"use strict";
import * as vscode from "vscode";
import * as fs from "fs";
import * as Path from "path";
import { CompletionItemsCache } from "./completion_items_cache";
import { CompletionItemsCacheImpl } from "./completion_items_cache_impl";
import { resolveCompletionItemDetails, packageNameToModuleName } from "./uri_helpers";


export function activate(context: vscode.ExtensionContext) {
    const workspaceFolders = vscode.workspace.workspaceFolders;

    if (!workspaceFolders) {
        console.warn(
            "No workspace folder. typescript-namespace-imports-vscode-plugin will not work"
        );
        return;
    }

    const moduleCompletionItemsCache: CompletionItemsCache = new CompletionItemsCacheImpl(
        workspaceFolders
    );

    const workspaceWatcher = vscode.workspace.onDidChangeWorkspaceFolders(
        moduleCompletionItemsCache.handleWorkspaceChange
    );

    const fileSystemWatcher = vscode.workspace.createFileSystemWatcher(
        "**/*.{ts,tsx,js,jsx}",
        false,
        true, // ignore content changes — we use onDidSaveTextDocument instead
        false
    );
    fileSystemWatcher.onDidCreate(moduleCompletionItemsCache.addFile);
    fileSystemWatcher.onDidDelete(moduleCompletionItemsCache.deleteFile);

    // Watch tsconfig.json create/delete to discover new roots (content changes
    // are handled by per-file fs.watch watchers inside the cache)
    const tsconfigWatcher = vscode.workspace.createFileSystemWatcher(
        "**/tsconfig.json",
        false,
        true, // ignore content changes — handled by fs.watch on resolved files
        false
    );
    const refreshAliases = (uri: vscode.Uri) => {
        if (uri.path.includes("node_modules")) return;
        moduleCompletionItemsCache.refreshPathAliases(uri);
    };
    tsconfigWatcher.onDidCreate(refreshAliases);
    tsconfigWatcher.onDidDelete(refreshAliases);

    const packageJsonWatcher = vscode.workspace.createFileSystemWatcher(
        "**/package.json",
        true, // ignore create — picked up lazily on next completion
        false,
        false
    );
    const invalidatePkgJson = (uri: vscode.Uri) => {
        if (uri.path.includes("node_modules")) return;
        moduleCompletionItemsCache.invalidatePackageJson(uri);
    };
    packageJsonWatcher.onDidChange(invalidatePkgJson);
    packageJsonWatcher.onDidDelete(invalidatePkgJson);

    const supportedLanguages = new Set(["typescript", "typescriptreact", "javascript", "javascriptreact"]);
    const saveWatcher = vscode.workspace.onDidSaveTextDocument(doc => {
        if (!supportedLanguages.has(doc.languageId)) return;
        moduleCompletionItemsCache.updateFile(doc.uri);
    });

    const provider = vscode.languages.registerCompletionItemProvider(
        [
            { scheme: "file", language: "typescript" },
            { scheme: "file", language: "typescriptreact" },
            { scheme: "file", language: "javascript" },
            { scheme: "file", language: "javascriptreact" },
        ],
        {
            provideCompletionItems(doc: vscode.TextDocument, position: vscode.Position) {
                const wordRange = doc.getWordRangeAtPosition(position);
                if (!wordRange) return new vscode.CompletionList([], true);

                const word = doc.getText(wordRange);
                return moduleCompletionItemsCache.getCompletionList(doc, word);
            },
            resolveCompletionItem(item: vscode.CompletionItem) {
                return resolveCompletionItemDetails(item);
            },
        }
    );

    const packageJsonProvider = vscode.languages.registerCompletionItemProvider(
        { scheme: "file", pattern: "**/package.json" },
        {
            provideCompletionItems(doc: vscode.TextDocument, position: vscode.Position) {
                const textBefore = doc.getText(new vscode.Range(new vscode.Position(0, 0), position));
                if (!isInsideNamespaceNameAliasesKey(textBefore)) return;

                try {
                    const content = JSON.parse(doc.getText());
                    const deps = new Set<string>();
                    for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
                        const section = content[key];
                        if (section && typeof section === "object") {
                            for (const name of Object.keys(section)) deps.add(name);
                        }
                    }

                    const existing = new Set(Object.keys(content.namespaceNameAliases ?? {}));
                    const items: vscode.CompletionItem[] = [];
                    const nodeModulesDir = Path.join(Path.dirname(doc.uri.fsPath), "node_modules");

                    for (const dep of deps) {
                        if (!existing.has(dep)) {
                            const item = new vscode.CompletionItem(dep, vscode.CompletionItemKind.Module);
                            item.insertText = `${dep}": "${packageNameToModuleName(dep)}`;
                            items.push(item);
                        }

                        // Sub-path exports
                        try {
                            const depPkgPath = Path.join(nodeModulesDir, dep, "package.json");
                            const depPkg = JSON.parse(fs.readFileSync(depPkgPath, "utf-8"));
                            const exports = depPkg.exports;
                            if (!exports || typeof exports !== "object") continue;
                            for (const key of Object.keys(exports)) {
                                if (key === "." || key === "./package.json" || !key.startsWith("./") || key.includes("*")) continue;
                                const importPath = `${dep}/${key.slice(2)}`;
                                if (existing.has(importPath)) continue;
                                const item = new vscode.CompletionItem(importPath, vscode.CompletionItemKind.Module);
                                item.insertText = `${importPath}": "${packageNameToModuleName(importPath)}`;
                                items.push(item);
                            }
                        } catch {
                            // skip unreadable dep
                        }
                    }

                    return items;
                } catch {
                    return;
                }
            },
        },
        '"'
    );

    context.subscriptions.push(provider, packageJsonProvider, fileSystemWatcher, workspaceWatcher, saveWatcher, tsconfigWatcher, packageJsonWatcher);
}

// eslint-disable-next-line @typescript-eslint/no-empty-function
export function deactivate() {}

/** Checks if the cursor is inside a key position within the "namespaceNameAliases" object */
function isInsideNamespaceNameAliasesKey(textBefore: string): boolean {
    const aliasIdx = textBefore.lastIndexOf('"namespaceNameAliases"');
    if (aliasIdx === -1) return false;
    const afterAlias = textBefore.slice(aliasIdx);
    const openBrace = afterAlias.indexOf("{");
    if (openBrace === -1) return false;
    const closeBrace = afterAlias.indexOf("}");
    return closeBrace === -1;
}

