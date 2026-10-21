import { describe, expect, it } from 'vitest';
import { PlaintextRemoteStorage } from '../../../src/storage/remoteStorage';
import { MemoryRemote } from '../../fixtures/memoryRemote';

describe('plaintext storage boundary', () => {
	it('retains ordinary file operations and prevents plaintext writes into a Cryptomator destination', async () => {
		const raw = new MemoryRemote(),
			storage = new PlaintextRemoteStorage(raw.files, raw.client, 'plain');
		const bytes = new TextEncoder().encode('plain content').buffer;
		await storage.createFolder('plain');
		const item = await storage.uploadFile('plain/note.md', bytes);
		expect(new Uint8Array(await storage.downloadFile(item.id))).toEqual(new Uint8Array(bytes));
		expect(new Uint8Array(await storage.downloadFileByPath('plain/note.md'))).toEqual(
			new Uint8Array(bytes)
		);
		expect(await storage.fileExists('plain/note.md')).toBe(true);
		expect((await storage.getFileMetadata('plain/note.md')).id).toBe(item.id);
		await storage.moveFile(item.id, 'plain/moved.md');
		await storage.deleteFileByPath('plain/moved.md');
		expect(await storage.listAllItems('plain')).toHaveLength(1);
		await storage.getDelta(undefined, 'plain');
		await raw.uploadFile('plain/vault.cryptomator', bytes);
		await expect(storage.uploadFile('plain/no-leak.md', bytes)).rejects.toThrow(
			'Enable encrypted sync'
		);
		await expect(storage.getDelta(undefined, 'plain')).rejects.toThrow();
		await expect(storage.listAllItems('plain')).rejects.toThrow();
		expect(await raw.fileExists('plain/no-leak.md')).toBe(false);
	});
});
