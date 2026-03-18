import * as vscode from "vscode";

export interface CompletionItemsCache {
    handleWorkspaceChange: (event: vscode.WorkspaceFoldersChangeEvent) => void;
    addFile: (uri: vscode.Uri) => void;
    updateFile: (uri: vscode.Uri) => void;
    deleteFile: (uri: vscode.Uri) => void;
    refreshPathAliases: (tsconfigUri: vscode.Uri) => void;
    invalidatePackageJson: (uri: vscode.Uri) => void;
    getCompletionList: (doc: vscode.TextDocument, query: string) => vscode.CompletionList | [];
}
