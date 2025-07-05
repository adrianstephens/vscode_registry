import * as path from "path";
import {ChildProcess, spawn} from 'child_process';

const HIVES_SHORT 	= ['HKLM', 'HKU', 'HKCU', 'HKCR', 'HKCC'];
const HIVES_LONG	= ['HKEY_LOCAL_MACHINE', 'HKEY_USERS', 'HKEY_CURRENT_USER', 'HKEY_CLASSES_ROOT', 'HKEY_CURRENT_CONFIG'];
const KEY_PATTERN   = /(\\[a-zA-Z0-9_\s]+)*/;
const PATH_PATTERN	= /^(HKEY_LOCAL_MACHINE|HKEY_CURRENT_USER|HKEY_CLASSES_ROOT|HKEY_USERS|HKEY_CURRENT_CONFIG).*\\(.*)$/;
const ITEM_PATTERN  = /^\s*(.*?)\s+(REG_[A-Z_]+)(\s+\((.*?)\))?\s*(.*)$/;

let		reg_exec = process.platform === 'win32' ? path.join(process.env.windir || '', 'system32', 'reg.exe') : "REG";
const	hosts32 : Record<string, KeyHost> = {};
const	hosts64 : Record<string, KeyHost> = {};

export const HIVES			= HIVES_LONG;
export const REMOTE_HIVES	= HIVES.slice(0, 2);

export interface Type {
	name:	string;
	parse:	(s:string, i?:number)=>Data;
}

export interface Data {
	raw:	Uint8Array;
	value:	any;
	constructor: {name:string};
}

interface KeyBase {
	name:		string;
	parent?:	KeyPromise;
	path:		string;
	exists:		() => Promise<boolean>;
	destroy:	() => Promise<void>;
	create:		() => Promise<KeyPromise>;
	deleteValue:(name: string) 				=> Promise<void>;
	setValue:	(name: string, data: Data)	=> Promise<void>;
	export:		(file: string) 				=> Promise<void>;
	toString:	() => string;
	[Symbol.iterator]: () => IterableIterator<KeyPromise>;
}

export interface Key extends KeyBase {
	values: 	Record<string, any>;
	[key:string|symbol]:any;
}


export interface SearchResults {
	found:	(x: string)=>void;
}

export interface SearchOptions {
	recursive?: 		boolean;	//default: true
	case_sensitive?:	boolean;	//default: false
	exact?:				boolean;	//default: false
	keys?: 				boolean;	//default: true
	values?:    		boolean;	//default: true
	data?: 				boolean;	//default: true
}

function hex_to_bytes(s: string) {
	return new Uint8Array(Array.from({length: Math.ceil(s.length / 2)}, (_, i) => s.slice(i * 2, (i + 1) * 2)).map(i => parseInt(i, 16)));
}
function bytes_to_hex(value: Uint8Array) {
	return `${Array.from(value).map(i => i.toString(16).padStart(2, '0')).join(',')}`;
}
function string_to_bytes(buffer:ArrayBuffer, offset: number, value: string) {
	const a = new DataView(buffer, offset);
	for (let i = 0; i < value.length; i++)
		a.setUint16(i * 2, value.charCodeAt(i), true);
	a.setUint16(value.length * 2, 0, true);
	return offset + (value.length + 1) * 2;
}

function bytes_to_string(buffer: ArrayBuffer) {
	const s = new TextDecoder('utf-16le').decode(buffer);
	return s.endsWith('\0') ? s.slice(0, -1) : s;
}

class OTHER implements Data {
	static parse(s:string, i?:number) { return new OTHER(hex_to_bytes(s), i); }
	constructor(public value: Uint8Array, public type?:number) {}
	get raw() { return this.value; }
}

class NONE implements Data {
	static parse(s:string) { return new NONE(hex_to_bytes(s)); }
	constructor(public value: Uint8Array) {}
	get raw() { return this.value; }
}

class BINARY extends NONE {
	static parse(s:string) { return new BINARY(hex_to_bytes(s)); }
}
class LINK extends NONE {
	static parse(s:string) { return new LINK(hex_to_bytes(s)); }
}
class RESOURCE_LIST extends NONE {
	static parse(s:string) { return new RESOURCE_LIST(hex_to_bytes(s)); }
}
class FULL_RESOURCE_DESCRIPTOR extends NONE {
	static parse(s:string) { return new FULL_RESOURCE_DESCRIPTOR(hex_to_bytes(s)); }
}
class RESOURCE_REQUIREMENTS_LIST extends NONE {
	static parse(s:string) { return new RESOURCE_REQUIREMENTS_LIST(hex_to_bytes(s)); }
}
class SZ implements Data {
	static parse(s:string) { return new SZ(s); }
	constructor(public value: string) {}
	get raw() { 
		const length = this.value.length;
		const a = new Uint16Array(length + 1);
		for (let i = 0; i < length; i++)
			a[i] = this.value.charCodeAt(i);
		a[length] = 0;
		return new Uint8Array(a.buffer);
	}
}
class EXPAND_SZ extends SZ {
	static parse(s:string) { return new EXPAND_SZ(s); }
}
class DWORD implements Data {
	static parse(s:string) { return new DWORD(+s); }
	constructor(public value: number) {}
	get raw() { 
		const bytes = new Uint8Array(4);
		new DataView(bytes.buffer).setUint32(0, this.value, true);
		return bytes;
	}	
}
class DWORD_BIG_ENDIAN implements Data {
	static parse(s:string) { return new DWORD_BIG_ENDIAN(+s); }
	constructor(public value: number) {}
	get raw() { 
		const bytes = new Uint8Array(4);
		new DataView(bytes.buffer).setUint32(0, this.value, false);
		return bytes;
	}	
}
class MULTI_SZ implements Data {
	static parse(s:string) { return new MULTI_SZ(s.split('\\0')); }
	constructor(public value: string[]) {}
	get raw() { 
		const length = this.value.reduce((acc, i) => acc + i.length + 1, 0);
		const a = new Uint16Array(length + 1);
		const end = this.value.reduce((acc, i) => {
			for (let j = 0; j < i.length; j++)
				a[acc + j] = i.charCodeAt(j);
			a[acc + i.length] = 0;
			return acc + i.length + 1;
		}, 0);
		return new Uint8Array(a.buffer);
	}

}
class QWORD implements Data {
	static parse(s:string) { return new QWORD(BigInt(s)); }
	constructor(public value: bigint) {}
	get raw() { 
		const bytes = new Uint8Array(8);
		new DataView(bytes.buffer).setBigUint64(0, this.value, true);
		return bytes;
	}	
}

export const TYPES : Record<string, Type> = {
	NONE:   					NONE,
	SZ: 						SZ,
	EXPAND_SZ:  				EXPAND_SZ,
	BINARY: 					BINARY,
	DWORD:  					DWORD,
	DWORD_BIG_ENDIAN:   		DWORD_BIG_ENDIAN,
	LINK:   					LINK,
	MULTI_SZ:   				MULTI_SZ,
	RESOURCE_LIST:  			RESOURCE_LIST,
	FULL_RESOURCE_DESCRIPTOR:   FULL_RESOURCE_DESCRIPTOR,
	RESOURCE_REQUIREMENTS_LIST: RESOURCE_REQUIREMENTS_LIST,
	QWORD:  					QWORD,
};

export function string_to_type(type: string) : Type|undefined {
	return TYPES[type.startsWith('REG_') ? type.substring(4) : type];
}
export function number_to_type(type: number) : Type {
	return type >= 0 && type < 12
		? Object.values(TYPES)[type]
		: OTHER;
}

export function data_to_regstring(value: Data, strict: boolean = false) {
	switch (value.constructor.name) {
		case 'OTHER':						return `hex(${(((value as OTHER).type??0)>>>0).toString(16)}):${bytes_to_hex(value.value)}`;
		case 'NONE':						return `hex(0):${bytes_to_hex(value.value)}`;
		case 'LINK':						return `hex(6):${bytes_to_hex(value.value)}`;
		case 'RESOURCE_LIST':				return `hex(8):${bytes_to_hex(value.value)}`;
		case 'FULL_RESOURCE_DESCRIPTOR':	return `hex(9):${bytes_to_hex(value.value)}`;
		case 'RESOURCE_REQUIREMENTS_LIST':	return `hex(a):${bytes_to_hex(value.value)}`;
		case 'BINARY':						return `hex:${bytes_to_hex(value.value)}`;

		case 'EXPAND_SZ':
			if (strict) {
				const d: string = value.value;
				const bytes = new Uint8Array((d.length + 1) * 2);
				string_to_bytes(bytes.buffer, 0, d);
				return `hex(2):${bytes_to_hex(bytes)}`;
			}
			//falls through
		case 'SZ':
			return `"${value.value}"`;

		case 'DWORD_BIG_ENDIAN':
			if (strict) {
				const bytes = new Uint8Array(4);
				new DataView(bytes.buffer).setUint32(0, value.value, true);
				return `hex(5): ${bytes_to_hex(bytes)}`;
			}
			//falls through
		case 'DWORD':
			return `dword:${value.value.toString(16)}`;

		case 'QWORD':
			if (strict) {
				const bytes = new Uint8Array(8);
				new DataView(bytes.buffer).setBigUint64(0, value.value, true);
				return `hex(b):${bytes_to_hex(bytes)}`;
			}
			//interpret as a filetime, after ~1900
			if (value.value > 300 * 365 * 24 * 3600 * 1e7) {
				const date = new Date(Number(value.value / 10000n - 11644473600000n));
				return `time: ${date.toString()}`;
			}
			return `qword:${value.value.toString(16)}`;

		case 'MULTI_SZ': {
			const d: string[] = value.value;
			if (strict) {
				const length 	= d.reduce((acc, i) => acc + i.length + 1, 1);
				const bytes		= new Uint8Array(length * 2);
				const end 		= d.reduce((acc, i) => string_to_bytes(bytes.buffer, acc, i), 0);
				bytes[end]		= 0;
				bytes[end + 1]	= 0;
				return `hex(7):${bytes_to_hex(bytes)}`;
			}
			return `[${d.map(i => `"${i}"`).join(',')}]`;
		}
		default:
			return '?';
	}
}

export function regstring_to_data(value: string) : Data|undefined {
	const re = /"(.*)"|(dword):([0-9a-fA-F]{8})|hex(\([0-0a-fA-F]+\))?:((?:[0-9a-fA-F]{2},)*[0-9a-fA-F]{2})/;
	const m = re.exec(value);
	if (m) {
		if (m[1])
			return new SZ(m[1]);

		if (m[2])
			return new DWORD(parseInt(m[3], 16));

		const data = new Uint8Array(m[5].split(',').map(v => parseInt(v, 16)));
		if (!m[4])
			return new BINARY(data);

		const dv = new DataView(data.buffer, 0);
		const itype = parseInt(m[4], 16);
		switch (itype) {
			case 0:		return new NONE(data);
			case 1:		return new SZ(bytes_to_string(data.buffer));
			case 2:		return new EXPAND_SZ(bytes_to_string(data.buffer));
			case 3:		return new BINARY(data);
			case 4:		return new DWORD(dv.getUint32(0, true));
			case 5:		return new DWORD_BIG_ENDIAN(dv.getUint32(0, false));
			case 6:		return new LINK(data);
			case 7:		return new MULTI_SZ(bytes_to_string(data.buffer).split('\0'));
			case 8:		return new RESOURCE_LIST(data);
			case 9:		return new FULL_RESOURCE_DESCRIPTOR(data);
			case 10:	return new RESOURCE_REQUIREMENTS_LIST(data);
			case 11:	return new QWORD(dv.getBigUint64(0, true));
			default:	return new OTHER(data, itype);
		}
	}
}

export function parseOutput(line: string) : [string, Data]|string|undefined {
	let match;
	if ((match = ITEM_PATTERN.exec(line))) {
		if (match[4]) {
			const itype = +match[4].trim();
			const type	= number_to_type(itype);
			return [match[1].trim(), type.parse(match[5], itype)];
		} else {
			const type = string_to_type(match[2].trim());
			if (type)
				return [match[1].trim(), type.parse(match[5])];
		}
	}
	if ((match = PATH_PATTERN.exec(line)))
		return match[0];
}

export class CancellablePromise<T> extends Promise<T> {
    public cancel: (reason?: any) => void;
    constructor(executor: (
		resolve: (value: T | PromiseLike<T>) => void,
		reject: (reason?: any) => void
	) => (reason?: any) => void) {
		let _abort: () => void;
		super((resolve, reject) => {
			_abort = executor(resolve, reject);
		});
		this.cancel	= _abort!;
	}
}

class Process {
	proc: ChildProcess;
	stdout: string = '';
	stderr: string = '';
	error?: Error;

	constructor(exec: string, args:string[], resolve: (proc: Process) => void, reject: (reason?: Error) => void, onlines?: (line : string) => void) {
		const proc = spawn(exec, args, {
			cwd: undefined,
			env: process.env,
			shell: false,
			//windowsHide: true,
			stdio: ['ignore', 'pipe', 'pipe']
		});
		this.proc = proc;

		proc.stdout.on('data', (data : any) => {
			this.stdout += data.toString();
			if (onlines) {
				const lines = this.stdout.split('\n');
				if (lines.length) {
					this.stdout = lines.pop()!;
					for (const i of lines)
						onlines(i.endsWith('\r') ? i.slice(0, -1) : i);
				}
			}
		});
		proc.stderr.on('data', (data : any) => { this.stderr += data.toString(); });

		proc.on('error', (error: Error) => { this.error = error; });

		proc.on('close', code => {
			if (onlines && this.stdout)
				onlines(this.stdout);
			if (this.error) {
				reject(new Error(this.error.message));
			} else if (code) {
				const message =`${exec} ${args.join(' ')} command exited with code ${code}:\n${this.stdout.trim()}\n${this.stderr.trim()}`;
				reject(new Error(message, {cause:code}));
			} else {
				resolve(this);
			}
		});
	}
}

function argName(name?:string) {
	return name ? ['/v', name] : ['/ve'];
}

function argData(value:Data) {
	const type = value.constructor;
	return ['/t', `REG_${type.name}`, ...(type == MULTI_SZ ? ['/s', ','] : []), '/d', value.value.toString()];
}

export class KeyPromise implements KeyBase {
	public _items?: Promise<Record<string, Data>>;
	public _keys: 	Record<string, KeyPromise> = {};
	public found?:	boolean;

	constructor(public name: string, public parent?: KeyPromise) {}

	private getRootAndPath(): [KeyPromise, string] {
		let key = this.name;
		let p 	= this.parent;
		if (!p)
			return [this, key];

		while (p.parent) {
			key = p.name + '\\' + key;
			p 	= p.parent;
		}
		if (p.name)
			key = `\\\\${p.name}\\${key}`;
		return [p, key];
	}
	
	public getView(root?:KeyPromise) : string|undefined {
		if (!root)
			root = this.getRootAndPath()[0];
		return hosts32[root.name] === root ? '32' : '64';
	}
	public getHost(root?:KeyPromise) : string|undefined {
		if (!root)
			root = this.getRootAndPath()[0];
		return root.name;
	}

	public get path() {
		return this.getRootAndPath()[1];
	}
	public toString() {
		return this.path;
	}

	private runCommand(command:string, ...args:string[]) {
		const [root, fullpath] = this.getRootAndPath();
		const view = hosts32[root.name] === root ? '32' : '64';
		if (view)
			args.push('/reg:' + view);

		return new Promise<Process>((resolve, reject) => new Process(reg_exec, [command, fullpath, ...args], resolve, reject));
	}

	private add_found_key(key:string) {
		if (key && key !== this.name) {
			if (!(key in this._keys))
				this._keys[key] = new KeyPromise(key, this);
			this._keys[key].found = true;
		}
	}

	public reread() : Promise<Record<string, any>> {
		return this._items = this.runCommand('QUERY', '/z').then(proc => {
			const items : Record<string, Data> = {};
			let lineNumber = 0;
			for (const i of proc.stdout.split('\n')) {
				const line = i.trim();
				if (line.length > 0) {
					if (lineNumber++ !== 0) {
						const match = ITEM_PATTERN.exec(line);
						if (match) {
							//const type = string_to_type(match[2].trim());
							const itype = +match[4].trim();
							const type	= number_to_type(itype);
							items[match[1].trim()] = type.parse(match[5], itype);
							continue;
						}
					}

					const match = PATH_PATTERN.exec(line);
					if (match)
						this.add_found_key(match[2]);
				}
			}
			for (let p : KeyPromise = this; !p.found && p.parent; p = p.parent)
				p.found = true;
			return items;
		});
	}

	public read() : Promise<Record<string, any>> {
		return this._items ?? this.reread();
	}

	public subkey(key: string) : KeyPromise {
		let p: KeyPromise = this;
		for (const i of key.split('\\')) {
			if (!p._keys[i])
				p._keys[i] = new KeyPromise(i, p);
			p = p._keys[i];
		}
		return p;
	}

	public async exists() : Promise<boolean> {
		return this.found || (!this.parent?.found && await this.read().then(() => true, () => false));
	}

	public async clear_values() : Promise<void> {
		if (this._items) {
			this._items.then(x => {
				for (const i in x)
					delete x[i];
			});
		}
		return this.runCommand('DELETE', '/f', '/va').then(() => {});
	}

	public async destroy() : Promise<void> {
		return this.runCommand('DELETE', '/f').then(
			() => { delete this.parent?._keys[this.name]; }
		);
	}

	public async create() {//}: Promise<KeyPromise> {
		await this.runCommand('ADD', '/f');
		return this;
	}

	public async deleteValue(name: string) : Promise<void> {
		return this.runCommand('DELETE', ...argName(name), '/f').then(
			() => {
				if (this._items)
					this._items.then(x => delete x[name]);
			}
		);
	}

	public async setValue(name: string, data: Data) : Promise<void> {
		return this.runCommand('ADD', ...argName(name), ...argData(data), '/f').then(
			() => {
				if (this._items)
					this._items.then(x => x[name] = data);
			}
		);
	}

	public async export(file: string) : Promise<void> {
		return this.runCommand('EXPORT', file, '/y').then(() => void 0);
	}

	public search(pattern: string, results: SearchResults, options?: SearchOptions) : CancellablePromise<Process> {
		const [root, fullpath] = this.getRootAndPath();
		const args = ['QUERY', fullpath, '/f', pattern];

		if (options?.recursive ?? true)
			args.push('/s');
		if (options?.case_sensitive)
			args.push('/c');
		if (options?.exact)
			args.push('/e');

		if (options && (options.keys ?? options.values ?? options.data !== undefined)) {
			if (options.keys)
				args.push('/k');
			if (options.values)
				args.push('/v');
			if (options.data)
				args.push('/d');
		}

		const view = hosts32[root.name] === root ? '32' : '64';
		if (view)
			args.push('/reg:' + view);

		return new CancellablePromise<Process>((resolve, reject) => {
			const process = new Process(reg_exec, args, resolve, reject, (line: string) => {
				results.found(line);
			});
			return (reason?: any) => {
				process.proc.kill();
				reject(reason);
			};
		});
	}

	[Symbol.iterator](): IterableIterator<KeyPromise> {
		return Object.values(this._keys).values();
	}				

	public then<T, U>(
		resolve: (value: Key) => T | PromiseLike<T>,
		reject?: (reason: any) => U | PromiseLike<U>
	) : PromiseLike<T | U> {
		return this.read().then(values => resolve(new Proxy(this, {
			get: (p, key: string | symbol) => {
				if (key === 'then')
					return;
				const v = p[key as keyof KeyPromise];
				if (v)
					return typeof v === 'function' ? v.bind(p) : v;

				if (key === Symbol.iterator)
					return p._keys.values;
		
				if (typeof key === 'string') {
					switch (key) {
						case 'values':
							return values;
						default:
							return p.subkey(key);
					}
				}
			},
			has: (p, key: string) => {
				return key in p._keys;
			},
			deleteProperty: (p, key: string) => {
				p.subkey(key).destroy();
				return true;
			},
		}) as unknown as Key),
			reject ? reason => reject(reason) : undefined
		);
	}
}

export function getKey(key:string, view?:string) : KeyPromise {
	let host = '';
	if (key.startsWith('\\\\')) {
		const i = key.indexOf('\\', 2);
		host	= key.substring(2, i);
		key		= key.substring(i + 1);
	}
	
	let i = key.indexOf('\\');
	if (i === -1)
		i = key.length;

	let hive_index = HIVES_LONG.indexOf(key.substring(0, i));
	if (hive_index === -1) {
		hive_index = HIVES_SHORT.indexOf(key.substring(0, i));
		if (hive_index === -1)
			throw new Error('illegal hive specified.');
		key = `${HIVES_LONG[hive_index]}${key.substring(i)}`;
	}

	if (host && hive_index >= 2)
		throw new Error('Remote access other supports HKLM or HKU');

	if (!KEY_PATTERN.test(key ?? ''))
		throw new Error('illegal key specified.');

	if (view && view != '32' && view != '64')
		throw new Error('illegal view specified (use 32 or 64)');

	const hosts = view == '32' ? hosts32 : hosts64;
	let p = hosts[host];
	if (!p)
		hosts[host] = p = new KeyHost(host);

	return p.subkey(key);
}


export function reset(view?: string, dirty?: KeyBase[]) {
	if (dirty) {
		for (const i of dirty)
			delete i.parent?._keys[i.name];
	} else {
		const hosts = view === '32' ? hosts32 : hosts64;
		for (const i in hosts)
			delete hosts[i];
		if (!view) {
			for (const i in hosts32)
				delete hosts32[i];
		}
	}
}


export async function importReg(file: string, machine?: string, view?: string, dirty?: KeyBase[]) : Promise<boolean> {
	const args = ['IMPORT', file];
	if (machine)
		args.push('/machine', machine);
	if (view)
		args.push('/reg:' + view);

	return new Promise<Process>((resolve, reject) => new Process(reg_exec, args, resolve, reject)).then(() => {
		if (dirty) {
			const parents = new Set<KeyPromise>();
			for (const i of dirty) {
				const parent = i.parent!;
				parents.add(parent);
				delete parent._keys[i.name];
			}
			Promise.all(Array.from(parents).map(p => p.reread())).then(() => true);

		} else {
			const hosts = view === '32' ? hosts32 : hosts64;
			for (const i in hosts)
				delete hosts[i];
		}
		return true;
	});
}

export async function setExecutable(file?: string) {
	if (!file)
		file = process.platform === 'win32' ? path.join(process.env.windir || '', 'system32', 'reg.exe') : "REG";
	reg_exec = file;
}

//-----------------------------------------------------------------------------
// views/hosts
//-----------------------------------------------------------------------------

export class KeyHost extends KeyPromise {
	get HKEY_LOCAL_MACHINE()	{ return this.subkey('HKEY_LOCAL_MACHINE'); }
	get HKEY_USERS()			{ return this.subkey('HKEY_USERS'); }
	get HKEY_CURRENT_USER()		{ return this.subkey('HKEY_CURRENT_USER'); }
	get HKEY_CLASSES_ROOT()		{ return this.subkey('HKEY_CLASSES_ROOT'); }
	get HKEY_CURRENT_CONFIG()	{ return this.subkey('HKEY_CURRENT_CONFIG'); }
}

export class View {
	constructor(private hosts: Record<string, KeyHost>) {}
	host(host:string) {
		let p = this.hosts[host];
		if (!p)
			this.hosts[host] = p = new KeyHost(host);
		return p;
	}
	get HKEY_LOCAL_MACHINE()	{ return this.host('').HKEY_LOCAL_MACHINE; }
	get HKEY_USERS()			{ return this.host('').HKEY_USERS; }
	get HKEY_CURRENT_USER()		{ return this.host('').HKEY_CURRENT_USER; }
	get HKEY_CLASSES_ROOT()		{ return this.host('').HKEY_CLASSES_ROOT; }
	get HKEY_CURRENT_CONFIG()	{ return this.host('').HKEY_CURRENT_CONFIG; }
	get HKLM()					{ return this.HKEY_LOCAL_MACHINE; }
	get HKU()					{ return this.HKEY_USERS; }
	get HKCU()					{ return this.HKEY_CURRENT_USER; }
	get HKCR()					{ return this.HKEY_CLASSES_ROOT; }
	get HKCC()					{ return this.HKEY_CURRENT_CONFIG; }
}

export const view32 		= new View(hosts32);
export const view64 		= new View(hosts64);
export const view_default	= view64;

export function host(name: string) { return view_default.host(name); }

export const HKEY_LOCAL_MACHINE 	= host('').HKEY_LOCAL_MACHINE;
export const HKEY_USERS    	 		= host('').HKEY_USERS;
export const HKEY_CURRENT_USER  	= host('').HKEY_CURRENT_USER;
export const HKEY_CLASSES_ROOT  	= host('').HKEY_CLASSES_ROOT;
export const HKEY_CURRENT_CONFIG	= host('').HKEY_CURRENT_CONFIG;
export const HKLM					= HKEY_LOCAL_MACHINE;
export const HKU					= HKEY_USERS;
export const HKCU					= HKEY_CURRENT_USER;
export const HKCR					= HKEY_CLASSES_ROOT;
export const HKCC					= HKEY_CURRENT_CONFIG;

