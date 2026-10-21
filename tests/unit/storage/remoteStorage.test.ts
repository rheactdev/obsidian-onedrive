import { describe, expect, it } from 'vitest';
import type { OneDriveItem } from '../../../src/types';
import type { EncryptedOneDriveItem, VersionedOneDriveItem } from '../../../src/crypto/types';
import { getRemoteContentVersion } from '../../../src/storage/remoteStorage';

describe('remote content versions', () => {
	const item: OneDriveItem = {
		id: 'file', name: 'note.md', size: 10,
		createdDateTime: '', lastModifiedDateTime: '',
		file: { mimeType: 'text/plain', hashes: { quickXorHash: 'real-graph-hash' } },
	};
	it('keeps plaintext change detection based on the genuine Graph hash', () => {
		const raw: VersionedOneDriveItem = { ...item, cTag: 'content-tag', eTag: 'item-tag' };
		expect(getRemoteContentVersion(raw)).toBe('real-graph-hash');
	});
	it('uses the explicit encrypted version without treating it as a Graph hash', () => {
		const encrypted: EncryptedOneDriveItem = {
			...item, ciphertextSize: 106, contentVersion: 'ciphertext-content-tag',
		};
		expect(getRemoteContentVersion(encrypted)).toBe('ciphertext-content-tag');
		expect(encrypted.file?.hashes?.quickXorHash).toBe('real-graph-hash');
	});
});
