import { buildSync } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { it, expect } from 'vitest';

it('encrypts and unlocks in a browser runtime without Node globals or native modules', async () => {
	const bundled = buildSync({
		entryPoints: ['src/crypto/cryptomator.ts'],
		bundle: true,
		platform: 'browser',
		format: 'iife',
		globalName: 'Vault',
		target: 'es2018',
		write: false,
	}).outputFiles[0].text;
	const result = await runInNewContext(
		`${bundled}\n(async () => {
    if (typeof Buffer !== 'undefined' || typeof require !== 'undefined' || typeof process !== 'undefined') throw new Error('Node globals present');
    const created = await Vault.CryptomatorCryptor.create('mobile password');
    const unlocked = await Vault.CryptomatorCryptor.unlock(created.config, created.masterkey, 'mobile password');
    const plain = new TextEncoder().encode('browser secret').buffer;
    const cipher = await created.cryptor.encrypt(plain);
    return new TextDecoder().decode(await unlocked.decrypt(cipher));
  })()`,
		{ crypto: webcrypto, TextEncoder, TextDecoder, setTimeout, clearTimeout }
	);
	expect(result).toBe('browser secret');
});
