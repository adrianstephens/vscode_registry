import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import * as registry from "./registry";
import {TreeItemCollapsibleState, Uri} from "vscode";
 
//-----------------------------------------------------------------------------
//	helpers
//-----------------------------------------------------------------------------

function compare<T>(a: T, b: T) : number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function BOMtoEncoding(bytes: Uint8Array): string {
	return	bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF ?'utf-8'
		:	bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF ? 'utf-16be'
		:	bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE ? 'utf-16le'
		: 	'utf-8';
}

function loadTextFile(file: string) {
	return vscode.workspace.fs.readFile(Uri.file(file)).then(
		bytes => new TextDecoder(BOMtoEncoding(bytes)).decode(bytes),
		error => (console.log(`Failed to load ${file} : ${error}`), '')
	);
}

async function rename(key: registry.Key, newName: string, value?: string) : Promise<boolean> {
	if (value) {
		const values = await key.values;
		if ((value in values) && !(newName in values)) {
			const data = values[value];
			await key.setValue(newName, data);
			delete values[value];
			return true;
		}

	} else if (key.parent && !(newName in key.parent)) {
		const file = path.join(os.tmpdir(), 'temp.reg');
		await key.export(file);
		let text = await loadTextFile(file);
		const re = /\[.*\\(.*)\]/d;
		const m = re.exec(text);
		if (m && m.indices) {
			const a = m.indices[1][0], b = m.indices[1][1];
			if (text.substring(a, b) == key.name) {
				text = text.slice(0, a) + newName + text.slice(b) + '[-' + text.slice(m.indices[0][0] + 1, b + 2);

				await vscode.workspace.fs.writeFile(Uri.file(file),  Buffer.from(text, 'utf8'));
				await registry.importReg(file, key.getView(), [key]);
				await vscode.workspace.fs.delete(Uri.file(file));

				return true;
			}
		}
	}
	return false;
}

async function yesno(message: string) {
	return await vscode.window.showInformationMessage(message, { modal: true }, 'Yes', 'No') === 'Yes';
}

async function pickFlags(flags: string[], initial: number, placeholder?: string): Promise<number | undefined> {
	interface item extends vscode.QuickPickItem {
		index: number;
	}

    return new Promise<number | undefined>(resolve => {
		const quickPick = vscode.window.createQuickPick<item>();

		quickPick.placeholder 	= placeholder;
		quickPick.canSelectMany = true;
		quickPick.items 		= flags.map((v, i) => ({label: v, index: i, alwaysShow: true, picked: (initial & (1 << i)) !== 0}));
		quickPick.selectedItems = quickPick.items.filter(i => i.picked);

		quickPick.onDidAccept(async () => {
			resolve(quickPick.selectedItems.reduce((flags, i) => flags | (1 << i.index), 0));
		});

		quickPick.onDidHide(() => {
			quickPick.dispose();
			resolve(undefined);
		});

		quickPick.show();
    });
}

async function showInputWithBackButton(prompt: string, placeholder?: string): Promise<string | undefined> {
    return new Promise<string | undefined>(resolve => {
		const input			= vscode.window.createInputBox();
		input.prompt 		= prompt;
		input.placeholder	= placeholder;
		//input.ignoreFocusOut = true; // Prevent the QuickPick from closing when the editor loses focus

		input.buttons	= [vscode.QuickInputButtons.Back];
		input.onDidTriggerButton(button => {
			if (button === vscode.QuickInputButtons.Back)
				input.hide();
		});

		input.onDidAccept(() => resolve(input.value));
		input.onDidHide(() => {
			input.dispose();
			resolve(undefined);
		});
		input.show();
	});
}

class WatchForClose {
	static editors: [vscode.TextEditor, (editor: vscode.TextEditor)=>void][] = [];
	static dispose: vscode.Disposable | undefined;
	
	static onClose(editor: vscode.TextEditor, func: (editor: vscode.TextEditor)=>void) : void {
		this.editors.push([editor, func]);
		if (!this.dispose) {
			this.dispose = vscode.window.tabGroups.onDidChangeTabs(event => {
				event.closed.forEach(tab => {
					const uri = (tab.input as vscode.TabInputText).uri.toString();
					this.editors.forEach((e, i) => {
						if (e[0].document.uri.toString() === uri) {
							e[1](e[0]);
							this.editors.splice(i, 1);
							if (this.editors.length == 0) {
								this.dispose?.dispose();
								this.dispose = undefined;
							}
						}
					});
				});
			});
		}
	}
}

//-----------------------------------------------------------------------------
//	TextDocumentContentProvider
//-----------------------------------------------------------------------------

class RegSearcher implements registry.SearchResults {
	private pending: string[] = [];
	private timeout: NodeJS.Timeout | undefined;
	private promise: registry.CancellablePromise<any>;

	text		= 'Windows Registry Editor Version 5.00\n';
	cancelled	= false;

	constructor(public uri: vscode.Uri, public onChange: vscode.EventEmitter<vscode.Uri>) {
		const enable = +uri.fragment;
		this.promise = registry.getKey(uri.path.replace(/\//g, '\\')).search(uri.query, this, {
			keys: 			(enable & 1) !== 0,
			values: 		(enable & 2) !== 0,
			data:   		(enable & 4) !== 0,
			case_sensitive: (enable & 8) !== 0,
			exact: 			(enable & 16) !== 0,
		});
		this.promise.then(
			()=> {
				console.log('search complete');
				if (!this.cancelled)
					this.found("finished");
			},
			error => {
				console.log(`Rejected: ${error}`);
				this.found("aborted");
			}
		);
	}

	found(x: string) {
		if (x.length == 0)
			return;

		const regitem = registry.parseOutput(x);
		if (!regitem) {
			x = ';' + x;
		} else if (typeof regitem === 'string') {
			x = '\n[' + regitem + ']';
		} else {
			x = `"${regitem[0]}"=${registry.data_to_regstring(regitem[1], true)}`;
		}

		this.pending.push(x);

		if (!this.timeout)
			this.timeout = setTimeout(()=> {
				if (!this.cancelled) {
					this.text += this.pending.join('\n') + '\n';
					this.pending.length = 0;
					this.onChange.fire(this.uri);
					this.timeout = undefined;
				}
			}, 1000);

		//this.text += x + '\n';
	}

	cancel() {
		this.cancelled = true;
		this.promise.cancel();
	}
}

class RegSearchTextProvider implements vscode.TextDocumentContentProvider {
	private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	onDidChange = this._onDidChange.event;
	open: Record<string, RegSearcher> = {};

	provideTextDocumentContent(uri: vscode.Uri): string {
		const uristring = uri.toString();
		if (uristring in this.open)
			return this.open[uristring].text;

		const prog = new RegSearcher(uri, this._onDidChange);
		this.open[uristring] = prog;
		return prog.text;
	}

	close(uri: vscode.Uri) {
		const uristring = uri.toString();
		if (uristring in this.open) {
			this.open[uristring].cancel();
			delete this.open[uristring];
		}
	}
}

//-----------------------------------------------------------------------------
//	File System Stub
//-----------------------------------------------------------------------------

class RegFS implements vscode.FileSystemProvider {
	private _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	get onDidChangeFile() { return this._onDidChangeFile.event; }

	constructor(public view: RegEditProvider) {}

	public static key_to_uri(keypath: string) {
		return Uri.parse(`reg:/${keypath.replace(/\\/g,'/')}.reg`);
	}
	public static value_to_uri(keypath: string, name:string, type:string) {
		return Uri.parse(`reg:/${keypath.replace(/\\/g,'/')}/${name}?type=${type}`);
	}
	public static uri_to_key(uri: Uri) {
		return uri.path.slice(1, -4).replace(/\//g, '\\');
	}

	async stat(uri: Uri): Promise<vscode.FileStat> {
		return {
			type: vscode.FileType.File,
			ctime: Date.now(),
			mtime: Date.now(),
			size: 0,
		};
	}

	async readFile(uri: Uri): Promise<Uint8Array> {
		const file = path.join(os.tmpdir(), 'temp.reg');
		return await registry.getKey(RegFS.uri_to_key(uri)).export(file).then(() => vscode.workspace.fs.readFile(Uri.file(file)));
	}

	async writeFile(uri: Uri, content: Uint8Array, options: { create: boolean, overwrite: boolean }): Promise<void> {
		const file = path.join(os.tmpdir(), 'temp.reg');
		await vscode.workspace.fs.writeFile(Uri.file(file),content);
		registry.importReg(file).then(() => {
			this.view.recreate();
			this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
		}).catch(err => vscode.window.showErrorMessage(`${err}`));

	}

	//stubs
	readDirectory(uri: Uri): [string, vscode.FileType][] { return []; }
	createDirectory(uri: Uri): void {}
	delete(uri: Uri): void {}
	rename(oldUri: Uri, newUri: Uri, options: { overwrite: boolean }): void {}
	watch(uri: Uri): vscode.Disposable { return new vscode.Disposable(() => {}); }
}

//-----------------------------------------------------------------------------
//	Tree View
//-----------------------------------------------------------------------------

type TypeDecoration = {
	icon?:	string,
	color?:	string,
	badge?:	string,
}

const decorations : Record<string, TypeDecoration> = {
	'NONE':   						{ icon: 'file-binary'},
	'SZ': 							{ icon: 'symbol-text',		color: 'charts.red',	badge: 'SZ'},
	'EXPAND_SZ':  					{ icon: 'symbol-text',		color: 'charts.yellow',	badge: 'ES'},
	'BINARY': 						{ icon: 'file-binary',		color: 'charts.purple',	badge: 'BI'},
	'DWORD':  						{ icon: 'symbol-number',	color: 'charts.orange',	badge: 'DW'},
	'DWORD_BIG_ENDIAN':   			{ icon: 'symbol-number',							badge: 'BE'},
	'LINK':   						{ icon: 'file-binary',								badge: 'L'},
	'MULTI_SZ':   					{ icon: 'symbol-text',		color: 'charts.blue',	badge: 'MS'},
	'RESOURCE_LIST':  				{ icon: 'file-binary',								badge: 'RL'},
	'FULL_RESOURCE_DESCRIPTOR':		{ icon: 'file-binary',								badge: 'RD'},
	'RESOURCE_REQUIREMENTS_LIST':	{ icon: 'file-binary',								badge: 'RR'},
	'QWORD':  						{ icon: 'symbol-number',	color: 'charts.green',	badge: 'QW'},
	'found':  						{ 							color: 'charts.red',	badge: '!'},
};

abstract class TreeItem extends vscode.TreeItem {
	public children: TreeItem[] | null = null;

	constructor(
		public parent: TreeItem | null,
		label: string | vscode.TreeItemLabel,
		contextValue: string,
		collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None
	) {
		super(label, collapsibleState);
		this.contextValue = contextValue;
		this.command = {
			command: 'regedit.select',
			title: 'Select',
			arguments: [this]
		};
	}

	public clearChildren(): void {
		if (this.children)
			this.children.forEach(c => c.clearChildren());
		this.children = null;
	}

	public createChildren(): Promise<TreeItem[]> {
		return Promise.resolve([]);
	}
}

class ValueTreeItem extends TreeItem {
	constructor(parent : KeyTreeItem, public name: string, public data: registry.Data) {
		super(parent, `${name} = ${registry.data_to_regstring(data)}`, 'value', TreeItemCollapsibleState.None);

		const type 			= data.constructor.name;
		const decoration	= decorations[type] ?? decorations.NONE;
		if (decoration.icon)
			this.iconPath	= new vscode.ThemeIcon(decoration.icon, decoration.color && new vscode.ThemeColor(decoration.color));
		this.resourceUri	= RegFS.value_to_uri(parent.key.path, name, type);
	}
}

class KeyTreeItem extends TreeItem {
	constructor(parent : TreeItem | null, public key: registry.KeyPromise) {
		super(parent, key.name, 'key', TreeItemCollapsibleState.Collapsed);
	}
	async createChildren(): Promise<TreeItem[]> {
		const children : TreeItem[] = [];
		const key2 = await this.key as registry.Key;
		for (const i of (Array.from(key2) as registry.KeyPromise[]).sort((a, b) => compare(a.name, b.name)))
			children.push(new KeyTreeItem(this, i));
		
		for (const [k, v] of Object.entries(key2.values))
			children.push(new ValueTreeItem(this, k, v));

		return children;
	}
}

class HostTreeItem extends TreeItem {
	constructor(parent : TreeItem | null, public host: string) {
		super(parent, host || 'Local', 'host', TreeItemCollapsibleState.Expanded);
		this.iconPath		= new vscode.ThemeIcon('device-desktop');
	}
	async createChildren(): Promise<TreeItem[]> {
		const children : TreeItem[] = [];
		if (this.host) {
			for (const h of registry.REMOTE_HIVES)
				children.push(new KeyTreeItem(null, registry.getKey(`\\\\${this.host}\\${h}`)));
		} else {
			for (const h of registry.HIVES)
				children.push(new KeyTreeItem(null, registry.getKey(h)));
		}
		return children;
	}
}

class RegEditProvider implements vscode.TreeDataProvider<TreeItem>, vscode.FileDecorationProvider {
	private hosts: 		string[]	= [];
	private children: 	TreeItem[]	= [];
	public	selection:	TreeItem[]	= [];

	private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined | null | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	public getTreeView() {
		return vscode.window.createTreeView("regedit-view", {treeDataProvider: this});
	}
	
	public refresh(node?: TreeItem|null): void {
		this._onDidChangeTreeData.fire(node);
	}
	public recreate(node?: TreeItem|null): void {
		if (node) {
			node.clearChildren();
		} else {
			this.children.forEach(c => c.clearChildren());
			this.children = [];
		}
		this._onDidChangeTreeData.fire(node);
	}

	public getTreeItem(element: TreeItem): vscode.TreeItem {
		return element;
	}

	public getChildren(element?: TreeItem) {//}: Promise<TreeItem[]> | undefined {
		if (element) {
			if (!element.children) {
				return element.createChildren().then(children => {
					return element.children = children;
				}).catch(err => {
					vscode.window.showInformationMessage(`${err}`);
					return element.children = [];
				});
			}
			return Promise.resolve(element.children);
		}

		if (!this.children.length) {
			if (this.hosts.length) {
				this.children.push(new HostTreeItem(null, ''));
				for (const i of this.hosts)
					this.children.push(new HostTreeItem(null, i));
			} else {
				for (const h of registry.HIVES)
					this.children.push(new KeyTreeItem(null, registry.getKey(h)));
			}
		}
		return Promise.resolve(this.children);
	}

	public getParent(element: TreeItem): TreeItem | null {
		return element.parent;
	}

	public getKeyItem(key: registry.Key|string): KeyTreeItem | undefined {
		if (typeof key !== 'string')
			key = key.path;
		let node: KeyTreeItem | undefined;
		for (const i of key.split('\\')) {
			const children: TreeItem[] | null = node ? node.children : this.children;
			if (!children || !(node = children.find(j => (j instanceof KeyTreeItem) && j.label == i) as KeyTreeItem | undefined))
				return;
		}
		return node;
	}

	public async getKeyItemCreate(key: registry.Key|string): Promise<KeyTreeItem | undefined> {
		if (typeof key !== 'string')
			key = key.path;
		let node: KeyTreeItem | undefined;
		for (const i of key.split('\\')) {
			const children = await this.getChildren(node);
			if (!children || !(node = children.find(j => (j instanceof KeyTreeItem) && j.label == i) as KeyTreeItem | undefined))
				return;
		}
		return node;
	}

	provideFileDecoration(uri: Uri, token: vscode.CancellationToken): vscode.ProviderResult<vscode.FileDecoration> {
		if (uri.scheme === 'reg') {
			const decoration = decorations[uri.query.substring(5)] ?? decorations.NONE;
			if (decoration.badge)
				return {
					badge: decoration.badge,
					color: decoration.color && !decoration.icon ? new vscode.ThemeColor(decoration.color) : undefined, 
					// tooltip: ""
				};
		}
		return null;  // to get rid of the custom fileDecoration
	}

	public addHost(host: string) {
		this.hosts.push(host);
		this.recreate();
	}
	public removeHost(host: string) {
		const i = this.hosts.indexOf(host);
		if (i !== -1) {
			this.hosts.splice(i, 1);
			this.recreate();
		}
	}
	async selectKey(key: string) {
		const item = await this.getKeyItemCreate(key);
		if (item)
			this.getTreeView().reveal(item);
	}
	
	async selectValue(key: string, value: string) {
		const item = await this.getKeyItemCreate(key);
		for (const child of await this.getChildren(item)) {
			if (child instanceof ValueTreeItem && child.name == value) {
				this.getTreeView().reveal(child);
				break;
			}
		}
	}
	selectByName(item: string) {
		const parts = item.split('@');
		return parts.length == 1
			? this.selectKey(parts[0])
			: this.selectValue(parts[0], parts[1]);
	}

	constructor() {
		vscode.window.registerTreeDataProvider('regedit-view', this);
		vscode.workspace.registerFileSystemProvider('reg', new RegFS(this), { isCaseSensitive: true });
		vscode.window.registerFileDecorationProvider(this);
	}
}

//-----------------------------------------------------------------------------
//	Folding range provider
//-----------------------------------------------------------------------------

class RegFolding implements vscode.FoldingRangeProvider {
	provideFoldingRanges(document: vscode.TextDocument, context: vscode.FoldingContext, token: vscode.CancellationToken) {
		const re 		= /^\[/;
		const ranges	= [];
		let 	start	= 0;
		for (let i = 0; i < document.lineCount; i++) {
			if (re.test(document.lineAt(i).text)) {
				if (start > 0)
					ranges.push(new vscode.FoldingRange(start, i - 1, vscode.FoldingRangeKind.Region));
				start = i;
			}
		}
		if (start > 0)
			ranges.push(new vscode.FoldingRange(start, document.lineCount - 1, vscode.FoldingRangeKind.Region));

		return ranges;
	}
}
//-----------------------------------------------------------------------------
//	Diagnostics
//-----------------------------------------------------------------------------

const key_re	= /^\s*\[-?(HKEY_LOCAL_MACHINE|HKEY_CURRENT_USER|HKEY_CLASSES_ROOT|HKEY_USERS|HKEY_CURRENT_CONFIG)(\\.*)?\]\s*(.*)$/di;
const value_re 	= /^\s*(@|".+?"|([^=]+))(\s*=)?\s*(-|".*"|[dq]word:[0-9a-f]+|hex(\([0-9a-f]+\))?:[0-9a-f,\s]+)?\s*(.*)$/di;
const comment_re	= /^\s*;/;

function regDiagnostics(doc: vscode.TextDocument) {
	const diagnostics: vscode.Diagnostic[] = [];

	function add_error(range: vscode.Range, message: string, severity = vscode.DiagnosticSeverity.Error) {
		diagnostics.push(new vscode.Diagnostic(range, message, severity));
	}

	function range_all(line0:number, line1:number) {
		return new vscode.Range(line0, 0, line1, doc.lineAt(line1).text.length);
	}
	function range_re(line:number, m: RegExpExecArray, i:number) {
		let [begin, end] = m.indices ? m.indices[i] : [m.index, m[0].length];
		let len = doc.lineAt(line).text.length;
		while (begin > len) {
			begin	-= len - 1;
			end		-= len - 1;
			len 	= doc.lineAt(++line).text.length;
		}
		let line2 = line;
		while (end > len) {
			end		-= len - 1;
			len 	= doc.lineAt(++line2).text.length;
		}
		return new vscode.Range(line, begin, line2, end);
	}

	let	state = 0;

	for (let line = 0; line < doc.lineCount; line++) {
		const	line0	= line;
		let		text	= doc.lineAt(line).text;

		if (comment_re.test(text))
			continue;

		while (text.endsWith('\\'))
			text = text.slice(0, -1) + doc.lineAt(++line).text;

		switch (state) {
			case 0:
				if (text) {
					if (text !== 'Windows Registry Editor Version 5.00' && text != 'REGEDIT4') {
						add_error(range_all(line0, line), "First line must be a valid version identifier");
					} else if (doc.lineAt(++line).text) {
						add_error(new vscode.Range(line, 0, line, 0), "Second line must blank");
					}
					state = 1;
				}
				break;

			case 1:
				if (text) {
					const m = key_re.exec(text);
					if (!m)
						add_error(range_all(line0, line), "Not a legal key");
					else if (m[3] && !comment_re.test(m[3]))
						add_error(range_re(line0, m, 3), "Extra characters after key", vscode.DiagnosticSeverity.Warning);
					state = 2;
				}
				break;

			case 2: 
				if (text) {
					const m = value_re.exec(text);
					if (!m) {
						add_error(range_all(line0, line), "Unrecognised value");
					} else if (!m[1]) {
						add_error(range_all(line0, line), "Can't find value name");
					} else {
						if (m[2])
							add_error(range_re(line0, m, 2), "value names should be within quotes", vscode.DiagnosticSeverity.Warning);

						if (!m[3])
							add_error(range_re(line0, m, 1), "Missing =");

						if (!m[4])
							add_error(range_re(line0, m, 6), "Misformed data");
						else if (m[6] && !comment_re.test(m[6]))
							add_error(range_re(line0, m, 6), "Extra characters after value", vscode.DiagnosticSeverity.Warning);
					}
				} else {
					state = 1;
				}
				break;
		}
	}
	if (state != 1)
		add_error(range_all(doc.lineCount - 1, doc.lineCount - 1), "Must end with a blank line");
	return diagnostics;
}

//-----------------------------------------------------------------------------
//	main extension entry point
//-----------------------------------------------------------------------------

function copy(item: TreeItem, strict: boolean) {
	if (item instanceof KeyTreeItem) {
		const key = item.key;
		vscode.env.clipboard.writeText(`[${key.path}]`);

	} else if (item instanceof ValueTreeItem) {
		const key = (item.parent as KeyTreeItem).key;
		vscode.env.clipboard.writeText(`[${key.path}]\n"${item.name}"=${registry.data_to_regstring(item.data, strict)}`);
	}
}

let selected: TreeItem;

export function activate(context: vscode.ExtensionContext) {

	function registerCommand(command: string, callback: (...args: any[]) => any, thisArg?: any) {
		context.subscriptions.push(vscode.commands.registerCommand(command, callback));
	}
	function registerTextEditorCommand(command: string, callback: (textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit, ...args: any[]) => void, thisArg?: any) {
		context.subscriptions.push(vscode.commands.registerTextEditorCommand(command, callback));
	}

	async function try_reg(func: () => Promise<void>) {
		try {
			await func();
		} catch (err) {
			vscode.window.showErrorMessage(`${err}`);
		}
	}

	//settings
	const config = vscode.workspace.getConfiguration('regedit');
	if (!config.get<string>('regExecutable'))
		config.update('regExecutable', context.asAbsolutePath("reg\\reg.exe"), vscode.ConfigurationTarget.Global);

	function get_settings() {
		const config = vscode.workspace.getConfiguration('regedit');
		registry.setExecutable(config.get<boolean>('useCustomReg') ? config.get<string>('regExecutable') : undefined);
	}
	get_settings();
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration('regedit'))
			get_settings();
	}));

	const regedit = new RegEditProvider;

	//regsearch provider
	const searchTextProvider = new RegSearchTextProvider;
	vscode.workspace.registerTextDocumentContentProvider('regsearch', searchTextProvider);

	//context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(e => {
	//	if (e.uri.scheme === 'regsearch')
	//		searchTextProvider.close(e.uri);
	//}));
  
	//folding
	context.subscriptions.push(vscode.languages.registerFoldingRangeProvider('reg', new RegFolding));

	//diagnostics
	const diagnostics = vscode.languages.createDiagnosticCollection('reg');
	context.subscriptions.push(diagnostics);

	const doc = vscode.window.activeTextEditor?.document;
	if (doc?.languageId === 'reg')
		diagnostics.set(doc.uri, regDiagnostics(doc));

	context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(e => {
		if (e && e.document.languageId == 'reg')
			diagnostics.set(e.document.uri, regDiagnostics(e.document));
	}));
	context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(e => {
		if (e && e.document.languageId == 'reg')
			diagnostics.set(e.document.uri, regDiagnostics(e.document));
	}));
	context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(doc => diagnostics.delete(doc.uri)));
  
	//commands
	registerCommand("regedit.select", async (item: TreeItem) => {
		selected = item;
	});

	registerCommand("regedit.refresh", async () => {
		registry.reset();
		regedit?.recreate();
	});

	registerCommand("regedit.addhost", async () => {
		const host = await vscode.window.showInputBox({prompt: 'Enter the host name'});
		if (host)
			regedit?.addHost(host);
	});

	registerCommand("regedit.edit",	async (item?: TreeItem, data?: string) => {
		if (item instanceof ValueTreeItem) {
			const old_data = item.data;
			if (!data) {
				data = await vscode.window.showInputBox({prompt: 'Enter the new value', value: old_data.value.toString()});
				if (!data)
					return;
			}
			const parent	= item.parent as KeyTreeItem;
			const data2		= old_data.constructor as registry.Type;
			
			try_reg(() => parent.key.setValue(item.name, data2.parse(data!)).then(() => regedit?.recreate(parent)));

		} else if (item instanceof KeyTreeItem) {
			const document = await vscode.workspace.openTextDocument(RegFS.key_to_uri(item.key.path));
			await vscode.window.showTextDocument(document, {viewColumn: vscode.ViewColumn.Active});
		}
	});
		
	registerCommand("regedit.createKey", async (item: string|TreeItem, name?: string) => {
		if (typeof(item) == 'string')
			return registry.getKey(item).create();

		if (item instanceof KeyTreeItem) {
			if (!name) {
				name = await vscode.window.showInputBox({prompt: 'Enter the name of the new Key'});
				if (!name)
					return;
			}

			try_reg(async () => {
				await item.key.subkey(name!).create();
				regedit?.recreate(item);
			});
		}
	});

	registerCommand("regedit.setValue",	async (item: string|TreeItem, name?: string, stype?: string, data?:string) => {
		if (!name) {
			name = await vscode.window.showInputBox({prompt: 'Enter the name of the new Value'});
			if (!name)
				return;
		}

		if (!stype) {
			const items = [
				{ label: 'REG_SZ'			},
				{ label: 'REG_MULTI_SZ'		},
				{ label: 'REG_EXPAND_SZ'	},
				{ label: 'REG_DWORD'		},
				{ label: 'REG_QWORD'		},
				{ label: 'REG_BINARY'		},
				{ label: 'REG_NONE'			},
			];
			
			const selectedItem = await vscode.window.showQuickPick(items, {placeHolder: 'Select the value type'});
			if (!selectedItem)
				return;
			stype = selectedItem.label;
		}

		const type = stype ? registry.string_to_type(stype) : registry.TYPES.SZ;
		if (!type)
			return;

		if (!data) {
			switch (stype) {
				case 'REG_EXPAND_SZ':
				case 'REG_SZ':			data = '<new>'; break;
				case 'REG_MULTI_SZ':	data = '<new>\\0<new>'; break;
				case 'REG_DWORD':
				case 'REG_QWORD':
				case 'REG_BINARY':		data = '0'; break;
				default:				break;
			}

			data = await vscode.window.showInputBox({prompt: 'Enter the initial value', value: data});
			if (!data)
				return;
		}

		const key = typeof(item) == 'string' ? registry.getKey(item) : item instanceof KeyTreeItem ? item.key : undefined;
		if (key) {
			try_reg(async () => {
				await key.setValue(name, type.parse(data));
				if (item instanceof KeyTreeItem)
					regedit.recreate(item);
			});
		}
	});

	registerCommand("regedit.delete", async (item: string|TreeItem) => {
		if (!item)
			item = selected;

		if (typeof(item) == 'string') {
			const split = item.lastIndexOf('\\');
			const key	= await registry.getKey(item.substring(0, split));
			const name	= item.substring(split + 1);
			if (name in key)
				delete key[name];
			else
				key.deleteValue(name);
			
		} else if (item instanceof HostTreeItem) {
			regedit.removeHost(item.host);

		} else if (item instanceof KeyTreeItem) {
			if (await yesno(`Are you sure you want to delete [${item.key.path}]?`)) {
				const parent	= item.parent as KeyTreeItem;
				try_reg(async () => {
					await item.key.destroy();
					regedit.recreate(parent);
				});
			}

		} else if (item instanceof ValueTreeItem) {
			const parent	= item.parent as KeyTreeItem;
			if (await yesno(`Are you sure you want to delete '${item.name}' from [${parent.key.path}]?`)) {
				try_reg(async () => {
					await parent.key.deleteValue(item.name);
					regedit.recreate(parent);
				});
			}
		}
	});

	registerCommand("regedit.rename", async (item: string|TreeItem, newname?: string) => {
		let key:	registry.Key;
		let name:	string;
		let value:	string = '';
		let parent:	KeyTreeItem | undefined;

		if (typeof(item) == 'string') {
			const split = item.lastIndexOf('\\');
			key		= await registry.getKey(item.substring(0, split));
			name	= item.substring(split + 1);
			if (name in key) {
				key		= key[value];
				value	= '';
			} else {
				value	= name;
			}
			parent = regedit?.getKeyItem(key);

		} else {
			parent	= item?.parent as KeyTreeItem;
			if (item instanceof KeyTreeItem) {
				key 	= await item.key;
				name 	= key.name;
			} else if (item instanceof ValueTreeItem) {
				key 	= await parent.key;
				name	= item.name as string;
				value	= name;
			} else {
				return;
			}
		}

		if (!newname) {
			newname = await vscode.window.showInputBox({
				value: name,
				prompt: 'Enter the new name',
			});
			if (!newname)
				return;
		}

		await rename(key, newname, value).then(() => regedit?.recreate(parent));		
	});

	registerCommand("regedit.export", async (item: string|TreeItem, file?: string) => {
		const key	= typeof(item) == 'string'		? registry.getKey(item)
					: item instanceof KeyTreeItem	? item.key
					: undefined;
		if (key) {
			if (!file) {
				const options: vscode.SaveDialogOptions = {
					filters: {
						'Registry Files': ['reg'],
						'All Files': ['*']
					}
				};
				file = (await vscode.window.showSaveDialog(options))?.fsPath;
			}

			if (file)
				return await key.export(file);
		}

	});

	registerCommand("regedit.import", async (file?: string) => {
		if (!file) {
			const options: vscode.OpenDialogOptions = {
				filters: {
					'Registry Files': ['reg'],
					'All Files': ['*']
				}
			};
			file = (await vscode.window.showOpenDialog(options))?.[0].fsPath;
		}
		if (file)
			registry.importReg(file).then(() => regedit?.recreate());
	});

	registerCommand("regedit.copy", async (item: TreeItem) => {
		copy(item, false);
	});

	registerCommand("regedit.copy_strict", async (item: TreeItem) => {
		copy(item, true);
	});

	let prevSearchFlags = 7;
	let prevSearchText = '';
	registerCommand("regedit.find",	async (item?: KeyTreeItem, pattern?: string, searchFlags?: number) => {
		for (;;) {
			if (!searchFlags && !(searchFlags = await pickFlags(["Keys", "Value", "Data", "Case Sensitive", "Exact"], prevSearchFlags, "Select search flags")))
				return;

			prevSearchFlags = searchFlags;
			//if (!pattern && !(pattern = await vscode.window.showInputBox({prompt: 'Enter the value to find'})))
			if (pattern || (pattern = await showInputWithBackButton('Enter the value to find', prevSearchText))) {
				prevSearchText = pattern;
				break;
			}

			searchFlags = undefined;
			pattern = undefined;
		}

		if (item instanceof KeyTreeItem) {
			const doc = await vscode.workspace.openTextDocument(vscode.Uri.from({
				scheme: 'regsearch',
				path: item.key.path.replace(/\\/g,'/'),
				query: pattern,
				fragment: searchFlags.toString()
			}));
			vscode.languages.setTextDocumentLanguage(doc, 'reg');
			const editor = await vscode.window.showTextDocument(doc, { preview: false });
			WatchForClose.onClose(editor, editor => searchTextProvider.close(editor.document.uri));

/*
			const 	doc 	= await vscode.workspace.openTextDocument({language: 'reg', content: 'Windows Registry Editor Version 5.00\n'});
			const 	editor	= await vscode.window.showTextDocument(doc);
			let		timeout: NodeJS.Timeout | undefined;
			const	pending: string[] = [];
			//let lastKey	= '';

			const flushPending = () => editor.edit(editBuilder => {
				const lastLine = doc.lineAt(doc.lineCount - 1);
				const lastLineRange = lastLine.range.with(undefined, new vscode.Position(lastLine.range.end.line, 0));
				editBuilder.insert(lastLineRange.end, pending.join('\n') + '\n');
				pending.length = 0;
				timeout = undefined;
			});

			const prog: registry.SearchResults = {
				update: x => {},
				found:	x => {
					if (x.length == 0)
						return;

					if (x[0] && x[0] != ' ') {
						x = '\n[' + x + ']';
					} else {
						const data = registry.output_to_data(x);
						if (data)
							x = `"${data[0]}"=${registry.data_to_regstring(data[1], true)}`;
					}
					pending.push(x);

					if (!timeout)
						timeout = setTimeout(flushPending, 100); // Adjust the delay as needed
				},
				cancelled:	false,
			};

			await item.key.search(pattern, prog);
			pending.push(';finished');
			flushPending();
*/
		}
	});

	registerTextEditorCommand("regedit.viewInReg", async editor => {
		const	doc		= editor.document;
		let		line 	= editor.selection.start.line;
		const	lineText = doc.lineAt(line).text;
		const 	key_re	= /^\s*\[(.*)\]/;

		if (lineText.startsWith('[')) {
			const key = key_re.exec(lineText)?.[1];
			if (key)
				regedit.selectKey(key);

		} else {
			const value = /"(.*)"=/.exec(lineText)?.[1];
			if (value) {
				let m:RegExpExecArray|null = null;
				while (--line >= 0 && !(m = key_re.exec(doc.lineAt(line).text)));

				const key = m?.[1];
				if (key)
					regedit.selectValue(key, value);
			}
		}
	});


}
  