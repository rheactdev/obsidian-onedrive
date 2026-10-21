import { FileOperations } from '../api/fileOperations';
import { OneDriveClient } from '../api/oneDriveClient';
import { DeltaResponse, OneDriveItem } from '../types';
import { CryptomatorCryptor, EncryptionError, buffer } from '../crypto/cryptomator';
import { RemoteStorage } from './remoteStorage';

const encode = (value: string) => buffer(new TextEncoder().encode(value));
const decode = (value: ArrayBuffer) => new TextDecoder('utf-8', { fatal: true }).decode(value);
const version = (item: OneDriveItem) =>
	item.cTag ||
	item.file?.hashes?.quickXorHash ||
	item.eTag ||
	`${item.lastModifiedDateTime}:${item.size}`;
function pathOf(path: string): string {
	const clean = path.replace(/^\/+|\/+$/g, '');
	if (
		clean &&
		clean
			.split('/')
			.some((p) => !p || p === '.' || p === '..' || /[\\]/.test(p) || p.includes('\0'))
	)
		throw new EncryptionError('Invalid encrypted sync path.');
	return clean.normalize('NFC');
}
interface Node {
	entry: OneDriveItem;
	storage: string;
	wrapper?: string;
	dirId?: string;
	contentDir?: string;
}
interface Control {
	version: string;
	text: string;
}
export interface EncryptedStorageState {
	version: 1;
	scope: string;
	cursor: string;
	items: OneDriveItem[];
	controls: Array<[string, Control]>;
	entries: OneDriveItem[];
}

/** A standard Cryptomator filesystem over the existing Graph transport.
 * All indexes are device-local and disposable. The remote vault is self-contained. */
export class CryptomatorStorage implements RemoteStorage {
	readonly encrypted = true;
	private rawItems = new Map<string, OneDriveItem>();
	private paths = new Map<string, OneDriveItem>();
	private controls = new Map<string, Control>();
	private nodes = new Map<string, Node>();
	private previous: OneDriveItem[] = [];
	private cursor?: string;
	private pendingCursor?: string;
	private committed?: EncryptedStorageState;
	private loaded = false;
	private fault?: Error;
	private closed = false;
	private pendingDirectories = new Map<string, Promise<Node>>();

	constructor(
		private raw: FileOperations,
		private client: OneDriveClient,
		readonly root: string,
		readonly cryptor: CryptomatorCryptor,
		readonly scope: string,
		cache?: EncryptedStorageState
	) {
		if (cache?.version === 1 && cache.scope === scope) {
			this.committed = cache;
			this.cursor = cache.cursor;
			this.rawItems = new Map(cache.items.map((i) => [i.id, i]));
			this.controls = new Map(cache.controls);
			this.previous = cache.entries;
		}
	}
	get isLocked(): boolean {
		return this.closed || !!this.fault;
	}
	close(): void {
		this.closed = true;
		this.cryptor.destroy();
	}
	isSharedDrive(): boolean {
		return false;
	} // All paths above this boundary are vault-relative.
	private check(): void {
		if (this.fault) throw this.fault;
		if (this.closed) throw new EncryptionError('Encrypted sync is locked. Unlock it in settings.');
	}
	private remote(path: string): string {
		return [this.root.replace(/\/+$/g, ''), path].filter(Boolean).join('/');
	}
	private remember(item: OneDriveItem, path: string): void {
		this.rawItems.set(item.id, item);
		this.paths.set(path, item);
	}
	private async control(path: string): Promise<string> {
		const item = this.paths.get(path);
		if (!item?.file || (item.size || 0) > 16384)
			throw new EncryptionError(
				'Encrypted folder metadata is missing or incomplete. Retry after other devices finish syncing.'
			);
		const cached = this.controls.get(item.id);
		if (cached?.version === version(item)) return cached.text;
		const value = decode(await this.raw.downloadFile(item.id));
		this.controls.set(item.id, { version: version(item), text: value });
		return value;
	}

	static async create(
		raw: FileOperations,
		client: OneDriveClient,
		root: string,
		password: string,
		scope: string
	): Promise<CryptomatorStorage> {
		if (!pathOf(root)) throw new EncryptionError('Choose a new, non-root destination folder.');
		if (await raw.fileExists(root))
			throw new EncryptionError(
				'The destination already exists. Choose a new folder or connect to the existing encrypted vault.'
			);
		const created = await CryptomatorCryptor.create(password);
		try {
			await raw.createFolder(root);
			await raw.uploadExclusive(`${root}/masterkey.cryptomator`, encode(created.masterkey));
			const rootDir = await created.cryptor.directoryPath('');
			await raw.createFolder(`${root}/${rootDir}`);
			await raw.uploadExclusive(
				`${root}/${rootDir}/dirid.c9r`,
				await created.cryptor.encrypt(encode(''))
			);
			// Publish the signed configuration last, after all required root metadata exists.
			await raw.uploadExclusive(`${root}/vault.cryptomator`, encode(created.config));
			const verified = await CryptomatorCryptor.unlock(
				decode(await raw.downloadFileByPath(`${root}/vault.cryptomator`)),
				decode(await raw.downloadFileByPath(`${root}/masterkey.cryptomator`)),
				password
			);
			created.cryptor.destroy();
			return new CryptomatorStorage(raw, client, root, verified, scope);
		} catch (error) {
			created.cryptor.destroy();
			throw error;
		}
	}

	prepareForSave(cursor?: string): EncryptedStorageState | undefined {
		if (cursor !== undefined && this.pendingCursor === cursor && this.loaded && !this.isLocked) {
			this.committed = {
				version: 1,
				scope: this.scope,
				cursor,
				items: Array.from(this.rawItems.values()),
				controls: Array.from(this.controls.entries()),
				entries: Array.from(this.nodes.values(), (n) => n.entry).filter(
					(i) => !!i.__resolvedVaultPath
				),
			};
			this.cursor = cursor;
		}
		return this.committed;
	}

	async getDelta(cursor?: string, _root?: string, subPath?: string): Promise<DeltaResponse> {
		this.check();
		if (subPath) throw new EncryptionError('Encrypted storage has one logical change stream.');
		const rootItem = await this.raw.getFileMetadata(this.root);
		const useCache = !!cursor && cursor === this.cursor && this.rawItems.size > 0;
		const response = await this.client.getDelta(
			useCache ? cursor : undefined,
			this.client.isSharedDrive() ? undefined : this.root,
			this.client.isSharedDrive() ? this.root : undefined
		);
		if (!useCache || response.reset) this.rawItems.clear();
		this.rawItems.set(rootItem.id, rootItem);
		// Last entry for an ID wins; delta ordering is not a filesystem traversal order.
		const batch = new Map(response.items.map((item) => [item.id, item]));
		for (const item of batch.values())
			if (item.deleted) {
				const remove = new Set([item.id]);
				let changed = true;
				while (changed) {
					changed = false;
					for (const raw of this.rawItems.values())
						if (
							raw.parentReference?.id &&
							remove.has(raw.parentReference.id) &&
							!remove.has(raw.id)
						) {
							remove.add(raw.id);
							changed = true;
						}
				}
				for (const id of remove) {
					this.rawItems.delete(id);
					this.controls.delete(id);
				}
			}
		for (const item of batch.values()) if (!item.deleted) this.rawItems.set(item.id, item);
		if (!this.rawItems.has(rootItem.id))
			throw new EncryptionError('The encrypted vault root was deleted.');
		this.paths = new Map([['', rootItem]]);
		const unresolved = new Map(this.rawItems);
		unresolved.delete(rootItem.id);
		let progress = true;
		while (unresolved.size && progress) {
			progress = false;
			const byId = new Map(Array.from(this.paths, ([path, item]) => [item.id, path]));
			for (const [id, item] of unresolved) {
				const parent = item.parentReference?.id ? byId.get(item.parentReference.id) : undefined;
				if (parent !== undefined) {
					this.paths.set([parent, item.name].filter(Boolean).join('/'), item);
					unresolved.delete(id);
					progress = true;
				}
			}
		}
		if (unresolved.size)
			throw new EncryptionError(
				'Encrypted vault listing is incomplete. Sync paused without applying deletions.'
			);
		if (!this.paths.get('masterkey.cryptomator')?.file)
			throw new EncryptionError('The vault masterkey file is missing. Restore it before syncing.');
		const verified = await CryptomatorCryptor.fromKey(
			await this.control('vault.cryptomator'),
			this.cryptor.exportKey()
		);
		const sameVault = verified.config.jti === this.cryptor.config.jti;
		verified.destroy();
		if (!sameVault) throw new EncryptionError('The remote vault identity changed.');
		// Compare against the committed cursor's snapshot, not a failed attempt's working tree.
		// Otherwise retrying a download failure could silently consume its remote change.
		const oldEntries =
			cursor && this.committed?.cursor === cursor
				? this.committed.entries
				: this.loaded
					? Array.from(this.nodes.values(), (n) => n.entry)
					: this.previous;
		await this.buildLogicalTree();
		this.loaded = true;
		this.pendingCursor = response.deltaLink;
		const current = Array.from(this.nodes.values(), (n) => n.entry).filter(
			(i) => !!i.__resolvedVaultPath
		);
		const ids = new Set(current.map((i) => i.id));
		const previous = new Map(oldEntries.map((i) => [i.id, i]));
		const changed =
			!cursor || !useCache || response.reset
				? current
				: current.filter((i) => {
						const old = previous.get(i.id);
						return (
							!old ||
							old.__resolvedVaultPath !== i.__resolvedVaultPath ||
							old.contentVersion !== i.contentVersion
						);
					});
		const deleted = cursor
			? oldEntries
					.filter((i) => !ids.has(i.id))
					.map((i) => ({ ...i, deleted: { state: 'deleted' } }))
			: [];
		return { items: [...changed, ...deleted], deltaLink: response.deltaLink };
	}

	private async buildLogicalTree(): Promise<void> {
		const next = new Map<string, Node>(),
			seen = new Set<string>();
		const children = new Map<string, Array<[string, OneDriveItem]>>();
		for (const [path, item] of this.paths) {
			const parent = path.slice(0, path.lastIndexOf('/'));
			const list = children.get(parent) || [];
			list.push([path, item]);
			children.set(parent, list);
		}
		const visit = async (
			logical: string,
			dirId: string,
			entry: OneDriveItem,
			wrapper?: string
		): Promise<void> => {
			if (seen.has(dirId)) throw new EncryptionError('Duplicate or cyclic encrypted directory ID.');
			seen.add(dirId);
			const contentDir = await this.cryptor.directoryPath(dirId);
			if (!this.paths.get(contentDir)?.folder)
				throw new EncryptionError('An encrypted content directory is missing. Sync paused.');
			next.set(logical, {
				entry,
				storage: wrapper ? `${wrapper}/dir.c9r` : '',
				wrapper,
				dirId,
				contentDir,
			});
			for (const [storage, raw] of children.get(contentDir) || []) {
				if (raw.name === 'dirid.c9r') continue;
				if (!raw.name.endsWith('.c9r') && !raw.name.endsWith('.c9s'))
					throw new EncryptionError('Unexpected entry in encrypted content directory.');
				const shortened = raw.name.endsWith('.c9s');
				const cipherName = shortened ? await this.control(`${storage}/name.c9s`) : raw.name;
				if ((await this.cryptor.storageName(cipherName)) !== raw.name)
					throw new EncryptionError('Invalid shortened encrypted filename.');
				const name = this.cryptor.decryptName(cipherName, dirId),
					path = logical ? `${logical}/${name}` : name;
				if (next.has(path)) throw new EncryptionError('Colliding encrypted filenames.');
				if (raw.folder && this.paths.has(`${storage}/dir.c9r`)) {
					const marker = this.paths.get(`${storage}/dir.c9r`)!;
					const childId = await this.control(`${storage}/dir.c9r`);
					if (!/^[\x21-\x7e]{1,36}$/.test(childId))
						throw new EncryptionError('Invalid encrypted directory ID.');
					await visit(path, childId, this.logical(marker, path, true), storage);
				} else {
					const content = shortened ? this.paths.get(`${storage}/contents.c9r`) : raw;
					if (!content?.file || (!shortened && raw.folder))
						throw new EncryptionError('Encrypted entry is incomplete or its type is unsupported.');
					next.set(path, {
						entry: this.logical(content, path, false),
						storage: shortened ? `${storage}/contents.c9r` : storage,
						wrapper: shortened ? storage : undefined,
					});
				}
			}
		};
		await visit('', '', {
			id: 'cryptomator-root',
			name: '',
			folder: { childCount: 0 },
			createdDateTime: '',
			lastModifiedDateTime: '',
		});
		this.nodes = next;
	}
	private logical(item: OneDriveItem, path: string, folder: boolean): OneDriveItem {
		return {
			...item,
			name: path.split('/').pop()!,
			__resolvedVaultPath: path,
			parentReference: undefined,
			folder: folder ? { childCount: 0 } : undefined,
			file: folder
				? undefined
				: { mimeType: 'application/octet-stream', hashes: { quickXorHash: version(item) } },
			size: folder ? 0 : CryptomatorCryptor.plaintextSize(item.size || 0),
			ciphertextSize: item.size,
			contentVersion: version(item),
		};
	}
	private async ready(): Promise<void> {
		this.check();
		if (!this.loaded) await this.getDelta(this.cursor);
	}
	async listAllItems(): Promise<OneDriveItem[]> {
		await this.getDelta();
		return Array.from(this.nodes.values(), (n) => n.entry).filter((i) => !!i.__resolvedVaultPath);
	}
	/** Recovery validates the source before its plan can delete any local-only files. */
	async validateSnapshot(): Promise<void> {
		await this.ready();
		for (const node of this.nodes.values())
			if (node.entry.file) new Uint8Array(await this.downloadFile(node.entry.id)).fill(0);
	}
	private async rawDirectory(path: string): Promise<void> {
		let current = '';
		for (const segment of path.split('/')) {
			current = [current, segment].filter(Boolean).join('/');
			if (!this.paths.has(current))
				this.remember(await this.raw.createFolder(this.remote(current)), current);
		}
	}
	private async exclusive(path: string, value: ArrayBuffer): Promise<OneDriveItem> {
		const item = await this.raw.uploadExclusive(this.remote(path), value);
		this.remember(item, path);
		return item;
	}
	private async ensureDirectory(path: string): Promise<Node> {
		const known = this.nodes.get(path);
		if (known) {
			if (known.dirId === undefined)
				throw new EncryptionError('A file occupies an encrypted folder path.');
			return known;
		}
		const pending = this.pendingDirectories.get(path);
		if (pending) return pending;
		const work = this.createDirectory(path);
		this.pendingDirectories.set(path, work);
		try {
			return await work;
		} finally {
			this.pendingDirectories.delete(path);
		}
	}
	private async destination(
		path: string
	): Promise<{ storage: string; wrapper?: string; parent: Node }> {
		const segments = path.split('/'),
			name = segments.pop()!;
		const parent = await this.ensureDirectory(segments.join('/'));
		const cipherName = this.cryptor.encryptName(name, parent.dirId!);
		const storageName = await this.cryptor.storageName(cipherName);
		const storage = `${parent.contentDir}/${storageName}`;
		if (storageName.endsWith('.c9s')) {
			await this.rawDirectory(storage);
			if (!this.paths.has(`${storage}/name.c9s`)) {
				try {
					await this.exclusive(`${storage}/name.c9s`, encode(cipherName));
				} catch (error) {
					const item = await this.raw.getFileMetadata(this.remote(`${storage}/name.c9s`));
					this.remember(item, `${storage}/name.c9s`);
					if ((await this.control(`${storage}/name.c9s`)) !== cipherName) throw error;
				}
			}
			return { storage: `${storage}/contents.c9r`, wrapper: storage, parent };
		}
		return { storage, parent };
	}
	private async createDirectory(path: string): Promise<Node> {
		const dest = await this.destination(path),
			wrapper = dest.wrapper || dest.storage,
			markerPath = `${wrapper}/dir.c9r`;
		await this.rawDirectory(wrapper);
		let marker: OneDriveItem, dirId: string;
		if (await this.raw.fileExists(this.remote(markerPath))) {
			marker = await this.raw.getFileMetadata(this.remote(markerPath));
			this.remember(marker, markerPath);
			dirId = await this.control(markerPath);
		} else {
			dirId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
				b.toString(16).padStart(2, '0')
			).join('');
			const contentDir = await this.cryptor.directoryPath(dirId);
			await this.rawDirectory(contentDir);
			await this.exclusive(`${contentDir}/dirid.c9r`, await this.cryptor.encrypt(encode(dirId)));
			try {
				marker = await this.exclusive(markerPath, encode(dirId));
			} catch (error) {
				if (!(await this.raw.fileExists(this.remote(markerPath)))) throw error;
				marker = await this.raw.getFileMetadata(this.remote(markerPath));
				this.remember(marker, markerPath);
				dirId = await this.control(markerPath);
			}
		}
		if (!/^[\x21-\x7e]{1,36}$/.test(dirId))
			throw new EncryptionError('Invalid encrypted directory ID.');
		const contentDir = await this.cryptor.directoryPath(dirId);
		if (!this.paths.has(contentDir)) {
			const content = await this.raw.getFileMetadata(this.remote(contentDir));
			this.remember(content, contentDir);
		}
		const node = {
			entry: this.logical(marker, path, true),
			storage: markerPath,
			wrapper,
			dirId,
			contentDir,
		};
		this.nodes.set(path, node);
		return node;
	}
	async createFolder(path: string): Promise<OneDriveItem> {
		await this.ready();
		return (await this.ensureDirectory(pathOf(path))).entry;
	}
	async uploadFile(
		path: string,
		bytes: ArrayBuffer,
		progress?: (uploaded: number, total: number) => void
	): Promise<OneDriveItem> {
		await this.ready();
		path = pathOf(path);
		if (!path || this.nodes.get(path)?.dirId !== undefined)
			throw new EncryptionError('Invalid encrypted file destination.');
		const dest = await this.destination(path);
		const cipher = await this.cryptor.encrypt(bytes);
		this.check();
		const item = await this.raw.uploadFile(this.remote(dest.storage), cipher, progress);
		this.remember(item, dest.storage);
		const entry = this.logical(item, path, false);
		this.nodes.set(path, { entry, storage: dest.storage, wrapper: dest.wrapper });
		return entry;
	}
	async downloadFile(id: string): Promise<ArrayBuffer> {
		await this.ready();
		if (!Array.from(this.nodes.values()).some((n) => n.entry.id === id && n.dirId === undefined))
			throw new EncryptionError('Unknown encrypted file ID.');
		try {
			return await this.cryptor.decrypt(await this.raw.downloadFile(id));
		} catch (error) {
			if (error instanceof EncryptionError) this.fault = error;
			throw error;
		}
	}
	async downloadFileByPath(path: string): Promise<ArrayBuffer> {
		return this.downloadFile((await this.getFileMetadata(path)).id);
	}
	async getFileMetadata(path: string): Promise<OneDriveItem> {
		await this.ready();
		const node = this.nodes.get(pathOf(path));
		if (!node) throw new Error('Encrypted file not found.');
		return node.entry;
	}
	async fileExists(path: string): Promise<boolean> {
		await this.ready();
		return this.nodes.has(pathOf(path));
	}
	private forgetRaw(path: string): void {
		for (const [p, item] of this.paths)
			if (p === path || p.startsWith(`${path}/`)) {
				this.paths.delete(p);
				this.rawItems.delete(item.id);
				this.controls.delete(item.id);
			}
	}
	async deleteFile(id: string): Promise<void> {
		await this.ready();
		const found = Array.from(this.nodes).find(([path, n]) => path && n.entry.id === id);
		if (!found) throw new EncryptionError('Unknown encrypted item ID.');
		const [path, node] = found;
		if (node.dirId !== undefined) {
			const descendants = Array.from(this.nodes)
				.filter(([p]) => p.startsWith(`${path}/`))
				.sort(([a], [b]) => b.length - a.length);
			for (const [p, child] of descendants)
				if (this.nodes.has(p)) await this.deleteFile(child.entry.id);
			const content = this.paths.get(node.contentDir!);
			if (content) {
				await this.raw.deleteFile(content.id);
				this.forgetRaw(node.contentDir!);
			}
		}
		const physical = node.wrapper || node.storage,
			rawItem = this.paths.get(physical);
		if (!rawItem) throw new EncryptionError('Encrypted item metadata is incomplete.');
		await this.raw.deleteFile(rawItem.id);
		this.forgetRaw(physical);
		this.nodes.delete(path);
	}
	async deleteFileByPath(path: string): Promise<void> {
		await this.deleteFile((await this.getFileMetadata(path)).id);
	}
	async moveFile(id: string, newPath: string): Promise<OneDriveItem> {
		await this.ready();
		newPath = pathOf(newPath);
		const found = Array.from(this.nodes).find(([path, n]) => path && n.entry.id === id);
		if (!found || !newPath) throw new EncryptionError('Unknown encrypted move source.');
		const [oldPath, node] = found;
		if (oldPath === newPath) return node.entry;
		if (this.nodes.has(newPath) || newPath.startsWith(`${oldPath}/`))
			throw new EncryptionError(
				'Encrypted move destination already exists or is inside its source.'
			);
		const dest = await this.destination(newPath);
		if (node.dirId !== undefined) {
			const target = dest.wrapper || dest.storage;
			if (dest.wrapper) {
				// A shortened destination already has its deterministic name mapping.
				const movedMarker = await this.raw.moveFile(id, this.remote(`${target}/dir.c9r`));
				await this.raw.deleteFile(this.paths.get(node.wrapper!)!.id);
				this.forgetRaw(node.wrapper!);
				this.remember(movedMarker, `${target}/dir.c9r`);
			} else {
				await this.raw.moveFile(this.paths.get(node.wrapper!)!.id, this.remote(target));
				this.forgetRaw(node.wrapper!);
				this.remember(await this.raw.getFileMetadata(this.remote(target)), target);
				this.remember(
					await this.raw.getFileMetadata(this.remote(`${target}/dir.c9r`)),
					`${target}/dir.c9r`
				);
				if (node.wrapper!.endsWith('.c9s')) {
					const oldName = `${target}/name.c9s`;
					await this.raw.deleteFileByPath(this.remote(oldName));
				}
			}
			node.wrapper = target;
			node.storage = `${target}/dir.c9r`;
			for (const [path, child] of Array.from(this.nodes))
				if (path.startsWith(`${oldPath}/`)) {
					const next = newPath + path.slice(oldPath.length);
					this.nodes.delete(path);
					child.entry = { ...child.entry, __resolvedVaultPath: next, name: next.split('/').pop()! };
					this.nodes.set(next, child);
				}
		} else {
			const moved = await this.raw.moveFile(id, this.remote(dest.storage));
			this.forgetRaw(node.storage);
			this.remember(moved, dest.storage);
			if (node.wrapper) {
				await this.raw.deleteFile(this.paths.get(node.wrapper)!.id);
				this.forgetRaw(node.wrapper);
			}
			node.storage = dest.storage;
			node.wrapper = dest.wrapper;
		}
		this.nodes.delete(oldPath);
		node.entry = { ...node.entry, __resolvedVaultPath: newPath, name: newPath.split('/').pop()! };
		this.nodes.set(newPath, node);
		return node.entry;
	}
}
