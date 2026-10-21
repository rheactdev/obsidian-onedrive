import { beforeAll, describe, expect, it } from 'vitest';
import { CryptomatorCryptor } from '../../../src/crypto/cryptomator';
import { CryptomatorStorage } from '../../../src/storage/cryptomatorStorage';
import { MemoryRemote } from '../../fixtures/memoryRemote';

const bytes = (value: string) => new TextEncoder().encode(value).buffer;
const text = (value: ArrayBuffer) => new TextDecoder().decode(value);
describe('Cryptomator storage', () => {
	let template: Awaited<ReturnType<typeof CryptomatorCryptor.create>>;
	beforeAll(async () => {
		template = await CryptomatorCryptor.create('test password');
	});
	async function setup() {
		const raw = new MemoryRemote();
		await raw.uploadFile('encrypted/vault.cryptomator', bytes(template.config));
		await raw.uploadFile('encrypted/masterkey.cryptomator', bytes(template.masterkey));
		const cryptor = await CryptomatorCryptor.fromKey(template.config, template.cryptor.exportKey());
		await raw.createFolder(`encrypted/${await cryptor.directoryPath('')}`);
		const storage = new CryptomatorStorage(
			raw.files,
			raw.client,
			'encrypted',
			cryptor,
			'account/root/vault'
		);
		const peer = async (
			cache?: Parameters<typeof CryptomatorStorage.prototype.prepareForSave>[0]
		) => {
			const key = await CryptomatorCryptor.fromKey(template.config, template.cryptor.exportKey());
			return new CryptomatorStorage(
				raw.files,
				raw.client,
				'encrypted',
				key,
				'account/root/vault',
				cache ? storage.prepareForSave(cache) : undefined
			);
		};
		return { raw, storage, peer };
	}
	it('keeps contents and names private and reconstructs all paths without plugin state', async () => {
		const { raw, storage, peer } = await setup();
		await storage.uploadFile('private/note.md', bytes('my confidential note'));
		await storage.uploadFile('.obsidian/app.json', bytes('{"theme":"private"}'));
		await storage.createFolder('empty/nested');
		const other = await peer(),
			items = await other.listAllItems();
		expect(items.map((i) => i.__resolvedVaultPath)).toEqual(
			expect.arrayContaining(['private/note.md', '.obsidian/app.json', 'empty/nested'])
		);
		expect(text(await other.downloadFileByPath('private/note.md'))).toBe('my confidential note');
		for (const [path, item] of raw.items) {
			expect(path).not.toContain('private');
			expect(path).not.toContain('note.md');
			if (item.file)
				expect(text(await raw.downloadFile(item.id))).not.toContain('my confidential note');
		}
	});
	it('syncs file changes, ID-only deletes, and expired-cursor full scans across devices', async () => {
		const { storage, peer } = await setup();
		const a = await storage.uploadFile('a.md', bytes('one')),
			b = await storage.uploadFile('b.md', bytes('two'));
		const other = await peer();
		let delta = await other.getDelta();
		other.prepareForSave(delta.deltaLink);
		await storage.uploadFile('a.md', bytes('new one'));
		await storage.deleteFile(b.id);
		delta = await other.getDelta(delta.deltaLink);
		expect(delta.items.some((i) => i.id === b.id && i.deleted)).toBe(true);
		expect(text(await other.downloadFile(a.id))).toBe('new one');
	});
	it('preserves IDs for normal and shortened file/folder moves and recursively deletes flattened folders', async () => {
		const { storage, peer } = await setup();
		const file = await storage.uploadFile('folder/note.md', bytes('keep me'));
		const long = 'long'.repeat(55) + '.md';
		expect((await storage.moveFile(file.id, `folder/${long}`)).id).toBe(file.id);
		let other = await peer();
		expect(text(await other.downloadFileByPath(`folder/${long}`))).toBe('keep me');
		await storage.moveFile(file.id, 'folder/short.md');
		const folder = await storage.getFileMetadata('folder');
		await storage.moveFile(folder.id, 'f'.repeat(220));
		other = await peer();
		expect(text(await other.downloadFileByPath(`${'f'.repeat(220)}/short.md`))).toBe('keep me');
		await storage.moveFile(folder.id, 'renamed');
		other = await peer();
		expect(text(await other.downloadFileByPath('renamed/short.md'))).toBe('keep me');
		await storage.deleteFile(folder.id);
		expect(await (await peer()).listAllItems()).toHaveLength(0);
	});
	it('coordinates directory creation on one device and uses the winning ID across devices', async () => {
		const { storage, peer } = await setup(),
			other = await peer();
		await Promise.all([storage.getDelta(), other.getDelta()]);
		await Promise.all([
			storage.uploadFile('shared/a.md', bytes('a')),
			storage.uploadFile('shared/b.md', bytes('b')),
			other.uploadFile('shared/c.md', bytes('c')),
		]);
		const restored = await peer();
		for (const name of ['a', 'b', 'c'])
			expect(text(await restored.downloadFileByPath(`shared/${name}.md`))).toBe(name);
	});
	it('reopens a persisted cursor/index together and keeps different storage identities separate', async () => {
		const { storage, peer } = await setup();
		await storage.uploadFile('a.md', bytes('one'));
		const delta = await storage.getDelta();
		const cache = storage.prepareForSave(delta.deltaLink)!;
		expect(cache.scope).toBe('account/root/vault');
		const other = await peer(delta.deltaLink);
		expect((await other.getDelta(delta.deltaLink)).items).toHaveLength(0);
		expect(storage.prepareForSave('uncommitted')).toEqual(cache);
	});
	it('replays changes when an attempt has not committed its cursor', async () => {
		const { storage, peer } = await setup();
		await storage.uploadFile('a.md', bytes('before'));
		const other = await peer();
		const initial = await other.getDelta();
		other.prepareForSave(initial.deltaLink);
		await storage.uploadFile('a.md', bytes('after'));
		for (let attempt = 0; attempt < 2; attempt++)
			expect(
				(await other.getDelta(initial.deltaLink)).items.some(
					(i) => i.__resolvedVaultPath === 'a.md'
				)
			).toBe(true);
	});
	it('drops stale raw items on a Graph cursor reset and still produces logical deletes', async () => {
		const { raw, storage, peer } = await setup();
		const file = await storage.uploadFile('deleted.md', bytes('old'));
		const other = await peer();
		const initial = await other.getDelta();
		other.prepareForSave(initial.deltaLink);
		await storage.deleteFile(file.id);
		const original = raw.getDelta.bind(raw);
		raw.getDelta = async (...args) => ({
			...(await original(...args)),
			items: (await original(...args)).items.filter((i) => !i.deleted),
			reset: true,
		});
		expect(
			(await other.getDelta(initial.deltaLink)).items.some((i) => i.id === file.id && i.deleted)
		).toBe(true);
	});
	it('fails closed for corrupted content and missing directory/configuration metadata', async () => {
		const { raw, storage, peer } = await setup();
		const file = await storage.uploadFile('folder/a.md', bytes('private'));
		const cipher = new Uint8Array(raw.bytes.get(file.id)!);
		cipher[cipher.length - 1] ^= 1;
		raw.bytes.set(file.id, cipher.buffer);
		await expect(storage.downloadFile(file.id)).rejects.toThrow('authentication failed');
		expect(storage.isLocked).toBe(true);
		await expect(storage.uploadFile('fallback.md', bytes('no plaintext'))).rejects.toThrow();
		const marker = Array.from(raw.items).find(([path]) => path.endsWith('/dir.c9r'))!;
		await raw.deleteFile(marker[1].id);
		await expect((await peer()).listAllItems()).rejects.toThrow();
		await raw.deleteFileByPath('encrypted/vault.cryptomator');
		await expect((await peer()).listAllItems()).rejects.toThrow();
	});
});
