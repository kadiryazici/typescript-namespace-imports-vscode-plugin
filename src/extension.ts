"use strict";
import * as vscode from "vscode";
import { CompletionItemsCache } from "./completion_items_cache";
import { CompletionItemsCacheImpl } from "./completion_items_cache_impl";
import { resolveCompletionItemDetails } from "./uri_helpers";

const openGraphQLTag = /gql`[^`]*$/;

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
                // Don't provide completions if the cursor is inside a gql`` template literal to
                // avoid conflicting with fragment name completions from the GraphQL extension.
                if (isInGraphQLTag(doc, position)) return new vscode.CompletionList([], true);

                const word = doc.getText(wordRange);
                return moduleCompletionItemsCache.getCompletionList(doc, word);
            },
            resolveCompletionItem(item: vscode.CompletionItem) {
                return resolveCompletionItemDetails(item);
            },
        }
    );

    context.subscriptions.push(provider, fileSystemWatcher, workspaceWatcher, saveWatcher, tsconfigWatcher);
}

// eslint-disable-next-line @typescript-eslint/no-empty-function
export function deactivate() {}

/**
 * Returns an approximation for whether the cursor is inside a gql`` template literal by searching
 * backwards in the document. Returns true if "gql`" is encountered before a standalone "`" or
 * a semicolon.
 */
function isInGraphQLTag(doc: vscode.TextDocument, position: vscode.Position): boolean {
    const textBeforeCursor = doc.lineAt(position.line).text.slice(0, position.character);
    if (openGraphQLTag.test(textBeforeCursor)) {
        return true;
    }
    if (textBeforeCursor.includes("`") || textBeforeCursor.includes(";")) {
        return false;
    }
    const scanLimit = Math.max(0, position.line - 100);
    for (let i = position.line - 1; i >= scanLimit; i--) {
        const line = doc.lineAt(i).text;
        if (openGraphQLTag.test(line)) {
            return true;
        }
        if (line.includes("`") || line.includes(";")) {
            return false;
        }
    }
    return false;
}
