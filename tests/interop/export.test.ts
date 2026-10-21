import { it, expect } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { MemoryRemote } from '../fixtures/memoryRemote';
import { CryptomatorStorage } from '../../src/storage/cryptomatorStorage';

it.skipIf(!process.env.CRYPTOMATOR_EXPORT_PATH)(
	'exports raw cloud bytes for the independent Cryptomator reader',
	async () => {
		const raw = new MemoryRemote();
		const storage = await CryptomatorStorage.create(
			raw.files,
			raw.client,
			'vault',
			'interoperability café 密码',
			'test'
		);
		const expected = new Map<string, Uint8Array>([
			[
				'note.md',
				new TextEncoder().encode('This private note must be recovered without plugin state.'),
			],
			['empty.md', new Uint8Array(0)],
			['目录/café 🙂.md', new TextEncoder().encode('你好, Cryptomator!')],
			['nested/' + 'l'.repeat(220) + '.md', new TextEncoder().encode('long filename')],
			['d'.repeat(220) + '/child.md', new TextEncoder().encode('long directory name')],
			['.obsidian/app.json', new TextEncoder().encode('{"theme":"moonstone"}')],
			['attachment.bin', Uint8Array.from({ length: 5 * 1024 * 1024 + 1 }, (_, i) => i % 251)],
		]);
		for (const [path, content] of expected) await storage.uploadFile(path, content.buffer);
		await storage.createFolder('empty-folder/nested');
		// Exercise both directions across the name-shortening boundary before exporting.
		const note = await storage.getFileMetadata('note.md');
		await storage.moveFile(note.id, 'n'.repeat(220) + '.md');
		await storage.moveFile(note.id, 'note.md');
		const location = process.env.CRYPTOMATOR_EXPORT_PATH!;
		for (const [path, item] of raw.items) {
			if (!path) continue;
			const destination = join(location, 'raw', path);
			if (item.folder) await mkdir(destination, { recursive: true });
			else {
				await mkdir(dirname(destination), { recursive: true });
				await writeFile(destination, new Uint8Array(await raw.downloadFile(item.id)));
			}
		}
		for (const [path, content] of expected) {
			const dest = join(location, 'expected', path);
			await mkdir(dirname(dest), { recursive: true });
			await writeFile(dest, content);
		}
		await mkdir(join(location, 'expected/empty-folder/nested'), { recursive: true });
		expect(expected.size).toBe(7);
	},
	30000
);
