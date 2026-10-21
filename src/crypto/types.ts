import type { OneDriveItem } from '../types';

/** Raw Graph metadata describes ciphertext, never local file contents. */
export interface VersionedOneDriveItem extends OneDriveItem {
	eTag?: string;
	cTag?: string;
}

/** Logical names and sizes are plaintext; encryption metadata stays separate. */
export interface EncryptedOneDriveItem extends OneDriveItem {
	ciphertextSize: number;
	contentVersion: string;
}

/** Device-local, rebuildable index committed alongside its Graph cursor. */
export interface EncryptedStorageState {
	version: 1;
	scope: string;
	cursor: string;
	items: VersionedOneDriveItem[];
	controls: Array<[string, { version: string; text: string }]>;
	entries: EncryptedOneDriveItem[];
}

export interface EncryptionSettings {
	folder: string;
	vaultId: string;
	scope: string;
	rememberKey: boolean;
	locked: boolean;
	cache?: EncryptedStorageState;
}
