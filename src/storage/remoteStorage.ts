import type { OneDriveItem } from '../types';
import type { FileOperations } from '../api/fileOperations';
import type { OneDriveClient } from '../api/oneDriveClient';

/** Only the existing operations consumed by sync; plaintext uses the original objects. */
export type RemoteFiles = Pick<
	FileOperations,
	| 'uploadFile'
	| 'downloadFile'
	| 'deleteFile'
	| 'deleteFileByPath'
	| 'moveFile'
	| 'createFolder'
>;

export type RemoteChangeSource = Pick<OneDriveClient, 'isSharedDrive' | 'getDelta' | 'listAllItems'> & {
	readonly encrypted?: boolean;
	validateSnapshot?(): Promise<void>;
};

export type RemoteStorage = RemoteFiles & RemoteChangeSource;

/** Keep Graph hashes genuine while reusing the sync state's remote-change token slot. */
export function getRemoteContentVersion(item: OneDriveItem): string {
	if ('contentVersion' in item && typeof item.contentVersion === 'string') {
		return item.contentVersion;
	}
	return item.file?.hashes?.quickXorHash || '';
}
