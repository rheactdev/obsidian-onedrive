import { DeltaResponse, OneDriveItem } from '../types';
import { FileOperations } from '../api/fileOperations';
import { OneDriveClient } from '../api/oneDriveClient';
import { EncryptionError } from '../crypto/cryptomator';

/** Items use logical names, plaintext sizes and resolved vault paths at this boundary.
 * Graph hashes/contentVersion describe the remote bytes, never plaintext hashes. */
export interface RemoteChangeSource {
	readonly encrypted?: boolean;
	isSharedDrive(): boolean;
	getDelta(cursor?: string, root?: string, subPath?: string): Promise<DeltaResponse>;
	listAllItems(root?: string): Promise<OneDriveItem[]>;
	validateSnapshot?(): Promise<void>;
}
export interface RemoteFiles {
	uploadFile(
		path: string,
		bytes: ArrayBuffer,
		onProgress?: (uploaded: number, total: number) => void
	): Promise<OneDriveItem>;
	downloadFile(id: string): Promise<ArrayBuffer>;
	downloadFileByPath(path: string): Promise<ArrayBuffer>;
	deleteFile(id: string): Promise<void>;
	deleteFileByPath(path: string): Promise<void>;
	moveFile(id: string, path: string): Promise<OneDriveItem>;
	createFolder(path: string): Promise<OneDriveItem>;
	getFileMetadata(path: string): Promise<OneDriveItem>;
	fileExists(path: string): Promise<boolean>;
}
export interface RemoteStorage extends RemoteFiles, RemoteChangeSource {}

/** Guard against accidentally turning encryption off while retaining its destination. */
export class PlaintextRemoteStorage implements RemoteStorage {
	constructor(
		private files: FileOperations,
		private client: OneDriveClient,
		private root: string
	) {}
	private async check(): Promise<void> {
		if (await this.files.fileExists([this.root, 'vault.cryptomator'].filter(Boolean).join('/'))) {
			throw new EncryptionError(
				'This destination is a Cryptomator vault. Enable encrypted sync before using it.'
			);
		}
	}
	isSharedDrive(): boolean {
		return this.client.isSharedDrive();
	}
	async getDelta(cursor?: string, root?: string, subPath?: string): Promise<DeltaResponse> {
		await this.check();
		return this.client.getDelta(cursor, root, subPath);
	}
	async listAllItems(root?: string): Promise<OneDriveItem[]> {
		await this.check();
		return this.client.listAllItems(root);
	}
	async uploadFile(
		path: string,
		bytes: ArrayBuffer,
		progress?: (uploaded: number, total: number) => void
	): Promise<OneDriveItem> {
		await this.check();
		return this.files.uploadFile(path, bytes, progress);
	}
	downloadFile(id: string): Promise<ArrayBuffer> {
		return this.files.downloadFile(id);
	}
	downloadFileByPath(path: string): Promise<ArrayBuffer> {
		return this.files.downloadFileByPath(path);
	}
	async deleteFile(id: string): Promise<void> {
		await this.check();
		return this.files.deleteFile(id);
	}
	async deleteFileByPath(path: string): Promise<void> {
		await this.check();
		return this.files.deleteFileByPath(path);
	}
	async moveFile(id: string, path: string): Promise<OneDriveItem> {
		await this.check();
		return this.files.moveFile(id, path);
	}
	async createFolder(path: string): Promise<OneDriveItem> {
		await this.check();
		return this.files.createFolder(path);
	}
	getFileMetadata(path: string): Promise<OneDriveItem> {
		return this.files.getFileMetadata(path);
	}
	fileExists(path: string): Promise<boolean> {
		return this.files.fileExists(path);
	}
}
