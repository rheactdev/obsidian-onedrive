import { App, TFile, TFolder } from 'obsidian';
import { LocalChange, LocalChangeType } from '../../src/types';
import type { EventManager } from '../../src/sync/eventManager';

export class LocalVault {
	nodes = new Map<string, TFile | TFolder>();
	contents = new Map<string, ArrayBuffer>();
	dirty = new Map<string, LocalChange>();
	ownWrites = new Set<string>();
	clock = Date.now();
	constructor() {
		const root = new TFolder();
		root.path = '';
		root.children = [];
		this.nodes.set('', root);
	}
	folder(path: string): TFolder {
		const known = this.nodes.get(path);
		if (known instanceof TFolder) return known;
		const parent = this.folder(path.split('/').slice(0, -1).join('/'));
		const folder = new TFolder();
		folder.path = path;
		folder.name = path.split('/').pop()!;
		folder.children = [];
		this.nodes.set(path, folder);
		parent.children.push(folder);
		return folder;
	}
	write(path: string, content: ArrayBuffer): void {
		const parent = this.folder(path.split('/').slice(0, -1).join('/'));
		let file = this.nodes.get(path);
		if (!(file instanceof TFile)) {
			file = new TFile();
			parent.children.push(file);
		}
		file.path = path;
		file.name = path.split('/').pop()!;
		file.extension = file.name.split('.').pop()!;
		file.basename = file.name.slice(0, -(file.extension.length + 1));
		file.stat = { mtime: ++this.clock, ctime: this.clock, size: content.byteLength };
		this.nodes.set(path, file);
		this.contents.set(path, content.slice(0));
	}
	read(path: string): ArrayBuffer {
		const bytes = this.contents.get(path);
		if (!bytes) throw new Error(`Not found: ${path}`);
		return bytes.slice(0);
	}
	remove(path: string): void {
		for (const [p, node] of Array.from(this.nodes))
			if (p === path || p.startsWith(`${path}/`)) {
				this.nodes.delete(p);
				this.contents.delete(p);
				for (const folder of this.nodes.values())
					if (folder instanceof TFolder)
						folder.children = folder.children.filter((child) => child !== node);
			}
	}
	async rename(node: TFile | TFolder, newPath: string): Promise<void> {
		if (this.nodes.has(newPath)) throw new Error('Destination exists');
		const old = node.path;
		for (const folder of this.nodes.values())
			if (folder instanceof TFolder)
				folder.children = folder.children.filter((child) => child !== node);
		this.folder(newPath.split('/').slice(0, -1).join('/')).children.push(node);
		for (const [path, child] of Array.from(this.nodes))
			if (path === old || path.startsWith(`${old}/`)) {
				const next = newPath + path.slice(old.length);
				this.nodes.delete(path);
				this.nodes.set(next, child);
				child.path = next;
				if (this.contents.has(path)) {
					this.contents.set(next, this.contents.get(path)!);
					this.contents.delete(path);
				}
			}
	}
	readonly adapter = {
		exists: async (path: string) => this.nodes.has(path),
		stat: async (path: string) => {
			const node = this.nodes.get(path);
			return node instanceof TFile
				? { type: 'file', ...node.stat }
				: node
					? { type: 'folder', mtime: 0, ctime: 0, size: 0 }
					: null;
		},
		read: async (path: string) => new TextDecoder().decode(this.read(path)),
		readBinary: async (path: string) => this.read(path),
		write: async (path: string, value: string) =>
			this.write(path, new TextEncoder().encode(value).buffer),
		writeBinary: async (path: string, value: ArrayBuffer) => this.write(path, value),
		mkdir: async (path: string) => {
			this.folder(path);
		},
		remove: async (path: string) => this.remove(path),
		rmdir: async (path: string) => this.remove(path),
		rename: async (from: string, to: string) => this.rename(this.nodes.get(from)!, to),
		list: async (path: string) => {
			const children = Array.from(this.nodes).filter(
				([p]) => p && p.split('/').slice(0, -1).join('/') === path
			);
			return {
				files: children.filter(([, n]) => n instanceof TFile).map(([p]) => p),
				folders: children.filter(([, n]) => n instanceof TFolder).map(([p]) => p),
			};
		},
	};
	readonly app = {
		vault: {
			configDir: '.obsidian',
			adapter: this.adapter,
			getFiles: () =>
				Array.from(this.nodes.values()).filter(
					(n) => n instanceof TFile && !n.path.startsWith('.obsidian/')
				),
			getRoot: () => this.nodes.get(''),
			getAbstractFileByPath: (path: string) =>
				path.startsWith('.obsidian/') ? null : this.nodes.get(path) || null,
			readBinary: async (file: TFile) => this.read(file.path),
			rename: (node: TFile | TFolder, path: string) => this.rename(node, path),
		},
		fileManager: { trashFile: async (node: TFile | TFolder) => this.remove(node.path) },
	} as unknown as App;
	readonly events = {
		getDirtyFiles: () => Array.from(this.dirty.values()),
		clearDirtyFiles: () => this.dirty.clear(),
		addDirtyFile: (path: string, type = LocalChangeType.MODIFY) =>
			this.dirty.set(path, { path, type }),
		removeDirtyPaths: (paths: string[]) => {
			for (const path of paths) this.dirty.delete(path);
		},
		markOwnWrites: (paths: string[]) => {
			for (const path of paths) this.ownWrites.add(path);
		},
		removeOwnWrite: (path: string) => this.ownWrites.delete(path),
		isOwnWrite: (path: string) => this.ownWrites.has(path),
		markInitialSyncDone: () => {},
		requeueChanges: (changes: LocalChange[]) => {
			for (const change of changes) this.dirty.set(change.path, change);
		},
	} as unknown as EventManager;
}
