import { beforeAll, describe, expect, it } from 'vitest';
import { CHUNK_SIZE, CryptomatorCryptor, buffer } from '../../../src/crypto/cryptomator';

describe('Cryptomator format 8', () => {
	let fixture: Awaited<ReturnType<typeof CryptomatorCryptor.create>>;
	beforeAll(async () => {
		fixture = await CryptomatorCryptor.create('café 密码 🔑');
	});
	it('unlocks its standard masterkey file with an NFC-equivalent password', async () => {
		const opened = await CryptomatorCryptor.unlock(
			fixture.config,
			fixture.masterkey,
			'cafe\u0301 密码 🔑'
		);
		expect(opened.exportKey()).toBe(fixture.cryptor.exportKey());
		opened.destroy();
	});
	it('rejects a wrong password, altered key metadata and an unsigned config', async () => {
		await expect(
			CryptomatorCryptor.unlock(fixture.config, fixture.masterkey, 'incorrect')
		).rejects.toThrow('Unable to unlock');
		const altered = JSON.parse(fixture.masterkey);
		altered.scryptCostParam = 2 ** 28;
		await expect(
			CryptomatorCryptor.unlock(fixture.config, JSON.stringify(altered), 'anything')
		).rejects.toThrow();
		await expect(
			CryptomatorCryptor.fromKey(fixture.config.replace(/.$/, '!'), fixture.cryptor.exportKey())
		).rejects.toThrow();
	});
	it.each([0, 1, CHUNK_SIZE - 1, CHUNK_SIZE, CHUNK_SIZE + 1, CHUNK_SIZE * 3, 5 * 1024 * 1024])(
		'round trips %i bytes with the standard size geometry',
		async (length) => {
			const bytes = Uint8Array.from({ length }, (_, i) => i % 251);
			const cipher = await fixture.cryptor.encrypt(buffer(bytes));
			expect(cipher.byteLength).toBe(68 + length + Math.ceil(length / CHUNK_SIZE) * 28);
			expect(CryptomatorCryptor.plaintextSize(cipher.byteLength)).toBe(length);
			expect(
				new Uint8Array(await fixture.cryptor.decrypt(cipher)).every((byte, i) => byte === bytes[i])
			).toBe(true);
		}
	);
	it('generates different ciphertext for repeated uploads of identical content', async () => {
		const bytes = new TextEncoder().encode('private note').buffer;
		expect(new Uint8Array(await fixture.cryptor.encrypt(bytes))).not.toEqual(
			new Uint8Array(await fixture.cryptor.encrypt(bytes))
		);
	});
	it('authenticates headers, chunk contents, order, and the binding to a file header', async () => {
		const bytes = new Uint8Array(CHUNK_SIZE * 2).buffer;
		const cipher = new Uint8Array(await fixture.cryptor.encrypt(bytes));
		for (const offset of [15, 68 + 15, cipher.length - 1]) {
			const corrupt = cipher.slice();
			corrupt[offset] ^= 1;
			await expect(fixture.cryptor.decrypt(corrupt.buffer)).rejects.toThrow(
				'authentication failed'
			);
		}
		const reordered = cipher.slice(),
			width = CHUNK_SIZE + 28;
		reordered.set(cipher.subarray(68 + width), 68);
		reordered.set(cipher.subarray(68, 68 + width), 68 + width);
		await expect(fixture.cryptor.decrypt(reordered.buffer)).rejects.toThrow();
		await expect(fixture.cryptor.decrypt(cipher.slice(0, 70).buffer)).rejects.toThrow();
		const other = new Uint8Array(await fixture.cryptor.encrypt(bytes));
		other.set(cipher.subarray(68), 68);
		await expect(fixture.cryptor.decrypt(other.buffer)).rejects.toThrow();
	});
	it('binds deterministic names to their parent and shortens long ciphertext names', async () => {
		const name = fixture.cryptor.encryptName('你好 café.md', 'parent');
		expect(fixture.cryptor.decryptName(name, 'parent')).toBe('你好 café.md');
		expect(() => fixture.cryptor.decryptName(name, 'different')).toThrow();
		expect(
			await fixture.cryptor.storageName(fixture.cryptor.encryptName('long'.repeat(70), 'parent'))
		).toMatch(/\.c9s$/);
		expect(await fixture.cryptor.directoryPath('')).toMatch(/^d\/[A-Z2-7]{2}\/[A-Z2-7]{30}$/);
	});
	it('disables all key operations after locking', async () => {
		const opened = await CryptomatorCryptor.fromKey(fixture.config, fixture.cryptor.exportKey());
		opened.destroy();
		await expect(opened.encrypt(new ArrayBuffer(0))).rejects.toThrow('locked');
		expect(() => opened.exportKey()).toThrow('locked');
	});
});
