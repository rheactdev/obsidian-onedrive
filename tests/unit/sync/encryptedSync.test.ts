import { beforeAll, describe, expect, it } from 'vitest';
import { CryptomatorCryptor } from '../../../src/crypto/cryptomator';
import { CryptomatorStorage } from '../../../src/storage/cryptomatorStorage';
import { SyncEngine } from '../../../src/sync/syncEngine';
import { SyncStateManager } from '../../../src/sync/syncState';
import { ConflictResolver } from '../../../src/sync/conflictResolver';
import { ConflictQueue } from '../../../src/sync/conflictQueue';
import {
	ConflictResolution,
	ConflictResolutionStrategy,
	LocalChangeType,
} from '../../../src/types';
import { shouldSyncVaultPath } from '../../../src/utils/pathUtils';
import { MemoryRemote } from '../../fixtures/memoryRemote';
import { LocalVault } from '../../fixtures/localVault';

const bytes = (value: string) => new TextEncoder().encode(value).buffer;
const text = (value: ArrayBuffer) => new TextDecoder().decode(value);
describe('encrypted sync through the complete sync engine', () => {
	let template: Awaited<ReturnType<typeof CryptomatorCryptor.create>>;
	beforeAll(async () => {
		template = await CryptomatorCryptor.create('sync password');
	});
	async function setup() {
		const raw = new MemoryRemote();
		await raw.uploadFile('vault/vault.cryptomator', bytes(template.config));
		await raw.uploadFile('vault/masterkey.cryptomator', bytes(template.masterkey));
		await raw.createFolder(`vault/${await template.cryptor.directoryPath('')}`);
		const device = async (
			strategy = ConflictResolutionStrategy.LAST_WRITE_WINS,
			pullOnly = false
		) => {
			const cryptor = await CryptomatorCryptor.fromKey(
				template.config,
				template.cryptor.exportKey()
			);
			const storage = new CryptomatorStorage(raw.files, raw.client, 'vault', cryptor, 'test');
			const local = new LocalVault(),
				state = new SyncStateManager();
			const queue = new ConflictQueue(local.app, state, local.events, '.obsidian');
			const engine = new SyncEngine(
				local.app,
				storage,
				storage,
				state,
				new ConflictResolver(strategy),
				local.events,
				'.obsidian',
				{
					conflictQueue: queue,
					shouldSyncPath: (path) => shouldSyncVaultPath(path, false, true, '.obsidian'),
					isPullOnlyMode: () => pullOnly,
					getNotificationLevel: () => 'off',
				}
			);
			const sync = async () => {
				await engine.performSync();
				storage.prepareForSave(state.getDeltaLink());
			};
			return { storage, local, state, queue, engine, sync };
		};
		return { raw, device };
	}
	it('uploads filtered files, downloads plaintext/settings and preserves empty folders on another device', async () => {
		const { device } = await setup(),
			a = await device();
		a.local.write('folder/note.md', bytes('private note'));
		a.local.write('.obsidian/app.json', bytes('{"theme":"moonstone"}'));
		a.local.write(
			'.obsidian/plugins/onedrive-sync/data.json',
			bytes('never upload device secrets')
		);
		a.local.write('.syncIgnore', bytes('ignored.md'));
		a.local.write('ignored.md', bytes('excluded'));
		a.local.folder('empty/nested');
		await a.sync();
		const b = await device(ConflictResolutionStrategy.LAST_WRITE_WINS, true);
		await b.sync();
		expect(text(b.local.read('folder/note.md'))).toBe('private note');
		expect(text(b.local.read('.obsidian/app.json'))).toBe('{"theme":"moonstone"}');
		expect(b.local.nodes.has('empty/nested')).toBe(true);
		const paths = (await a.storage.listAllItems()).map((i) => i.__resolvedVaultPath);
		expect(paths).not.toContain('ignored.md');
		expect(paths).not.toContain('.obsidian/plugins/onedrive-sync/data.json');
	});
	it('decrypts and compares equal-size files during first sync and both reconcile directions', async () => {
		const { device } = await setup(),
			a = await device();
		await a.storage.uploadFile('note.md', bytes('aaaa'));
		a.local.write('note.md', bytes('bbbb'));
		await a.sync();
		expect(text(a.local.read('note.md'))).toBe('aaaa');
		a.local.write('note.md', bytes('cccc'));
		await a.engine.reconcileFromCloud();
		expect(text(a.local.read('note.md'))).toBe('aaaa');
		a.local.write('note.md', bytes('dddd'));
		await a.engine.reconcileToCloud();
		expect(text(await a.storage.downloadFileByPath('note.md'))).toBe('dddd');
		a.state.clearState();
		await a.sync();
		expect(text(a.local.read('note.md'))).toBe('dddd');
	});
	it('applies remote folder moves before creating their destination and handles flattened subtree deletion', async () => {
		const { device } = await setup(),
			a = await device();
		a.local.write('before/note.md', bytes('unchanged'));
		await a.sync();
		const b = await device();
		await b.sync();
		const folder = await a.storage.getFileMetadata('before');
		await a.storage.moveFile(folder.id, 'after');
		await b.sync();
		expect(text(b.local.read('after/note.md'))).toBe('unchanged');
		expect(b.local.nodes.has('before')).toBe(false);
		await a.storage.deleteFile(folder.id);
		await b.sync();
		expect(b.local.nodes.has('after/note.md')).toBe(false);
	});
	it.each([ConflictResolutionStrategy.MANUAL, ConflictResolutionStrategy.CREATE_DUPLICATE])(
		'keeps conflict versions as plaintext locally with strategy %s',
		async (strategy) => {
			const { device } = await setup(),
				a = await device(strategy);
			await a.storage.uploadFile('note.md', bytes('base'));
			await a.sync();
			const b = await device();
			await b.sync();
			await b.storage.uploadFile('note.md', bytes('theirs'));
			a.local.write('note.md', bytes('mine'));
			a.local.dirty.set('note.md', { path: 'note.md', type: LocalChangeType.MODIFY });
			await a.sync();
			if (strategy === ConflictResolutionStrategy.MANUAL) {
				expect(a.queue.count).toBe(1);
				const entry = a.queue.getAll()[0];
				expect(text(await a.queue.readIncomingContent(entry.id))).toBe('theirs');
				await a.queue.resolve(entry.id, ConflictResolution.ACCEPT_BOTH);
			}
			expect(text(a.local.read('note.md'))).toBe('mine');
			const copy = Array.from(a.local.contents).find(([path]) => path.includes('(conflict '));
			expect(copy).toBeDefined();
			expect(text(copy![1])).toBe('theirs');
			await a.sync();
			const remoteCopy = (await a.storage.listAllItems()).find((i) =>
				i.__resolvedVaultPath?.includes('(conflict ')
			);
			expect(remoteCopy).toBeDefined();
			expect(text(await a.storage.downloadFile(remoteCopy!.id))).toBe('theirs');
		}
	);
	it('does not delete local-only files when cloud recovery encounters corrupted ciphertext', async () => {
		const { raw, device } = await setup(),
			a = await device();
		const file = await a.storage.uploadFile('note.md', bytes('remote'));
		a.local.write('keep.md', bytes('keep local'));
		const cipher = new Uint8Array(raw.bytes.get(file.id)!);
		cipher[cipher.length - 1] ^= 1;
		raw.bytes.set(file.id, cipher.buffer);
		await expect(a.engine.reconcileFromCloud()).rejects.toThrow('authentication failed');
		expect(text(a.local.read('keep.md'))).toBe('keep local');
		expect(a.local.nodes.has('note.md')).toBe(false);
	});
	it('keeps decomposed Unicode filesystem names stable while exporting NFC Cryptomator names', async () => {
		const { device } = await setup(),
			a = await device();
		const localPath = 'Cafe\u0301/note\u0301.md';
		a.local.write(localPath, bytes('unicode content'));
		await a.sync();
		await a.sync();
		expect(text(a.local.read(localPath))).toBe('unicode content');
		expect(a.local.contents.size).toBe(1);
		expect(
			(await a.storage.listAllItems()).some(
				(i) => i.__resolvedVaultPath === localPath.normalize('NFC')
			)
		).toBe(true);
		await a.engine.reconcileFromCloud();
		expect(text(a.local.read(localPath))).toBe('unicode content');
		const b = await device();
		await b.sync();
		expect(text(b.local.read(localPath.normalize('NFC')))).toBe('unicode content');
	});
	it('rejects local Unicode name collisions before writing to remote storage', async () => {
		const { device } = await setup(),
			a = await device();
		a.local.write('café.md', bytes('one'));
		a.local.write('cafe\u0301.md', bytes('two'));
		await expect(a.sync()).rejects.toThrow('same normalized Unicode name');
		expect(await a.storage.listAllItems()).toHaveLength(0);
	});
});
