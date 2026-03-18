import * as vscode from "vscode";
import * as Path from "path";
function toPascalCase(s: string): string {
    return s.replace(/(?:^|[-_.\s]+)(\w)/g, (_, c) => c.toUpperCase()).replace(/[-_.\s]+/g, "");
}

export interface PathAlias {
    /** Workspace-relative prefix the file must start with (e.g. "src/components/") */
    targetPrefix: string;
    /** Alias prefix to substitute in (e.g. "@components/") */
    aliasPrefix: string;
}

type ImportModuleSpecifier = "shortest" | "relative" | "non-relative" | "project-relative";

export function getImportModuleSpecifier(currentUri: vscode.Uri): ImportModuleSpecifier {
    const tsConfig = vscode.workspace.getConfiguration("typescript", currentUri);
    const tsSpecifier = tsConfig.inspect<ImportModuleSpecifier>("preferences.importModuleSpecifier");
    const tsExplicit = tsSpecifier?.workspaceFolderValue ?? tsSpecifier?.workspaceValue ?? tsSpecifier?.globalValue;
    if (tsExplicit) {
        return tsExplicit;
    }
    const jstsConfig = vscode.workspace.getConfiguration("js/ts", currentUri);
    return jstsConfig.get<ImportModuleSpecifier>("preferences.importModuleSpecifier", "shortest");
}

function stripExt(p: string): string {
    return p.slice(0, p.length - Path.extname(p).length);
}

function toRelativePath(targetUri: vscode.Uri, currentUri: vscode.Uri): string {
    const currentDir = Path.dirname(currentUri.path);
    const rel = Path.relative(currentDir, targetUri.path);
    const withoutExt = stripExt(rel);
    return withoutExt.startsWith(".") ? withoutExt : "./" + withoutExt;
}

function toProjectRelativePath(targetUri: vscode.Uri, workspacePath: string): string {
    return stripExt(Path.relative(workspacePath, targetUri.path));
}

function toAliasPath(targetUri: vscode.Uri, pathAliases: PathAlias[], workspacePath: string): string | null {
    const fileRelative = stripExt(Path.relative(workspacePath, targetUri.path));

    for (const { targetPrefix, aliasPrefix } of pathAliases) {
        const prefix = targetPrefix.endsWith("/") ? targetPrefix : targetPrefix + "/";
        if (fileRelative.startsWith(prefix)) {
            return aliasPrefix + fileRelative.slice(prefix.length);
        }
    }
    return null;
}


export function uriToImportPath(
    targetUri: vscode.Uri,
    currentUri: vscode.Uri,
    pathAliases: PathAlias[],
    specifier?: ImportModuleSpecifier,
    workspacePath?: string
): string {
    specifier ??= getImportModuleSpecifier(currentUri);
    const relativePath = toRelativePath(targetUri, currentUri);
    workspacePath ??= vscode.workspace.getWorkspaceFolder(targetUri)?.uri.path ?? "";

    switch (specifier) {
        case "relative":
            return relativePath;
        case "project-relative":
            return toProjectRelativePath(targetUri, workspacePath);
        case "non-relative":
            return toAliasPath(targetUri, pathAliases, workspacePath) ?? relativePath;
        case "shortest":
        default: {
            const candidates: string[] = [relativePath, toProjectRelativePath(targetUri, workspacePath)];
            const alias = toAliasPath(targetUri, pathAliases, workspacePath);
            if (alias) {
                candidates.push(alias);
            }
            return candidates.reduce((a, b) => (a.length <= b.length ? a : b));
        }
    }
}

export function uriToModuleName(uri: vscode.Uri): string {
    const fileName = Path.basename(uri.path, Path.extname(uri.path));
    const name = fileName === "index" ? Path.basename(Path.dirname(uri.path)) : fileName;
    return toPascalCase(name);
}

/** Converts a package name like `@seamapi/react` → `SeamapiReact`, `react` → `React` */
export function packageNameToModuleName(packageName: string): string {
    // Strip leading @ and treat slashes as word separators
    const cleaned = packageName.replace(/^@/, "").replace(/\//g, "-");
    return toPascalCase(cleaned);
}

export interface CompletionItemData {
    moduleName: string;
    importPath: string;
}

export function uriToCompletionItem(
    moduleName: string,
    importPath: string,
    description?: string,
): vscode.CompletionItem {
    const completionItem = new vscode.CompletionItem(moduleName, vscode.CompletionItemKind.Module);
    completionItem.detail = description ?? importPath;
    completionItem.sortText = "\0" + moduleName;
    (completionItem as unknown as { data: CompletionItemData }).data = { moduleName, importPath };
    return completionItem;
}

export function resolveCompletionItemDetails(item: vscode.CompletionItem): vscode.CompletionItem {
    const data = (item as unknown as { data?: CompletionItemData }).data;
    if (!data) return item;
    const { moduleName, importPath } = data;
    const doc = new vscode.MarkdownString();
    doc.appendMarkdown(`\`${importPath}\`\n\n`);
    doc.appendCodeblock(`import * as ${moduleName} from "${importPath}";`, "typescript");
    item.documentation = doc;

    const editor = vscode.window.activeTextEditor;
    const insertLine = editor ? findImportInsertLine(editor.document) : 0;
    const importEdit = `import * as ${moduleName} from "${importPath}";\n`;
    item.additionalTextEdits = [
        vscode.TextEdit.insert(new vscode.Position(insertLine, 0), importEdit),
    ];
    return item;
}

function findImportInsertLine(doc: vscode.TextDocument): number {
    let lastImportLine = -1;

    for (let i = 0; i < doc.lineCount; i++) {
        const line = doc.lineAt(i).text;
        if (/^\s*import\s/.test(line)) {
            lastImportLine = i;
        }
        // Stop scanning after we've passed the import block (non-empty, non-comment, non-import line)
        if (lastImportLine !== -1 && line.trim() !== "" && !/^\s*import\s/.test(line) && !/^\s*\/\//.test(line)) {
            break;
        }
    }

    // If we found imports, insert after the last one
    if (lastImportLine !== -1) return lastImportLine + 1;

    // No imports: find the first line that isn't a comment or empty
    for (let i = 0; i < doc.lineCount; i++) {
        const line = doc.lineAt(i).text;
        if (line.trim() === "") continue;
        if (/^\s*\/\//.test(line) || /^\s*\/\*/.test(line) || /^\s*\*/.test(line)) continue;
        return i;
    }

    return 0;
}
