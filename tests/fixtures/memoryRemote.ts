import { OneDriveItem, DeltaResponse } from '../../src/types';
import type { VersionedOneDriveItem } from '../../src/crypto/types';
import { FileOperations } from '../../src/api/fileOperations';
import { OneDriveClient } from '../../src/api/oneDriveClient';

/** Graph-shaped filesystem with stable IDs, parent references, tombstones and atomic creates. */
export class MemoryRemote {
	items = new Map<string, VersionedOneDriveItem>();
	bytes = new Map<string, ArrayBuffer>();
	deleted: OneDriveItem[] = [];
	counter = 0;
	readonly files = this as unknown as FileOperations;
	readonly client = this as unknown as OneDriveClient;
	constructor() {
		this.items.set('', this.item('', true, 'drive-root'));
	}
	private clean(path: string): string {
		return path.replace(/^\/+|\/+$/g, '');
	}
	private item(path: string, folder: boolean, id?: string): VersionedOneDriveItem {
		const n = ++this.counter,
			time = new Date(1700000000000 + n * 1000).toISOString();
		return {
			id: id || `id-${n}`,
			name: path.split('/').pop() || '',
			size: 0,
			folder: folder ? { childCount: 0 } : undefined,
			file: folder
				? undefined
				: { mimeType: 'application/octet-stream', hashes: { quickXorHash: `content-${n}` } },
			cTag: folder ? undefined : `content-${n}`,
			eTag: `etag-${n}`,
			parentReference: path
				? { id: this.items.get(path.split('/').slice(0, -1).join('/'))!.id }
				: undefined,
			createdDateTime: time,
			lastModifiedDateTime: time,
		};
	}
	isSharedDrive(): boolean {
		return false;
	}
	async getFileMetadata(path: string): Promise<OneDriveItem> {
		return this.getItemByPath(path);
	}
	async getItemByPath(path: string): Promise<OneDriveItem> {
		const item = this.items.get(this.clean(path));
		if (!item) throw new Error(`Not found: ${path}`);
		return structuredClone(item);
	}
	async fileExists(path: string): Promise<boolean> {
		return this.items.has(this.clean(path));
	}
	async createFolder(path: string): Promise<OneDriveItem> {
		path = this.clean(path);
		let current = '';
		for (const segment of path.split('/').filter(Boolean)) {
			current = [current, segment].filter(Boolean).join('/');
			if (!this.items.has(current)) this.items.set(current, this.item(current, true));
		}
		return this.getItemByPath(path);
	}
	async uploadFile(path: string, content: ArrayBuffer): Promise<OneDriveItem> {
		path = this.clean(path);
		await this.createFolder(path.split('/').slice(0, -1).join('/'));
		const old = this.items.get(path),
			next = this.item(path, false, old?.id);
		next.size = content.byteLength;
		this.items.set(path, next);
		this.bytes.set(next.id, content.slice(0));
		return structuredClone(next);
	}
	async uploadCreateOnly(path: string, content: ArrayBuffer): Promise<OneDriveItem> {
		path = this.clean(path);
		await this.createFolder(path.split('/').slice(0, -1).join('/'));
		// This check and publication run without an intervening await, like Graph conflictBehavior=fail.
		if (this.items.has(path)) throw new Error('nameAlreadyExists');
		const next = this.item(path, false);
		next.size = content.byteLength;
		this.items.set(path, next);
		this.bytes.set(next.id, content.slice(0));
		return structuredClone(next);
	}
	async downloadFile(id: string): Promise<ArrayBuffer> {
		const bytes = this.bytes.get(id);
		if (!bytes) throw new Error('Not found');
		return bytes.slice(0);
	}
	async downloadFileByPath(path: string): Promise<ArrayBuffer> {
		return this.downloadFile((await this.getItemByPath(path)).id);
	}
	async deleteFile(id: string): Promise<void> {
		const found = Array.from(this.items).find(([, item]) => item.id === id);
		if (!found) throw new Error('Not found');
		for (const [path, item] of this.items)
			if (path === found[0] || path.startsWith(`${found[0]}/`)) {
				this.items.delete(path);
				this.bytes.delete(item.id);
				this.deleted.push({ id: item.id, deleted: { state: 'deleted' } } as OneDriveItem);
			}
	}
	async deleteFileByPath(path: string): Promise<void> {
		return this.deleteFile((await this.getItemByPath(path)).id);
	}
	async moveFile(id: string, path: string): Promise<OneDriveItem> {
		path = this.clean(path);
		const found = Array.from(this.items).find(([, item]) => item.id === id);
		if (!found) throw new Error('Not found');
		if (this.items.has(path)) throw new Error('nameAlreadyExists');
		await this.createFolder(path.split('/').slice(0, -1).join('/'));
		for (const [oldPath, item] of Array.from(this.items))
			if (oldPath === found[0] || oldPath.startsWith(`${found[0]}/`)) {
				const newPath = path + oldPath.slice(found[0].length);
				this.items.delete(oldPath);
				const moved = { ...item };
				if (oldPath === found[0]) {
					moved.name = path.split('/').pop()!;
					moved.parentReference = {
						id: this.items.get(path.split('/').slice(0, -1).join('/'))!.id,
					};
				}
				this.items.set(newPath, moved);
			}
		return this.getItemByPath(path);
	}
	async getDelta(_cursor?: string, root = '', subPath?: string): Promise<DeltaResponse> {
		root = this.clean(subPath || root);
		return {
			items: [
				...Array.from(this.items)
					.filter(([path]) => path === root || path.startsWith(`${root}/`))
					.map(([, item]) => structuredClone(item))
					.reverse(),
				...this.deleted,
			],
			deltaLink: `delta-${this.counter}-${this.deleted.length}`,
		};
	}
	async listAllItems(root = ''): Promise<OneDriveItem[]> {
		return (await this.getDelta(undefined, root)).items.filter((i) => !i.deleted);
	}
}
