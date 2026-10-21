import { describe, expect, it } from 'vitest';
import type { App } from 'obsidian';
import { encryptionScope, EncryptionKeyStorage } from '../../../src/crypto/keyStorage';

describe('device-local encryption keys', () => {
	it('isolates accounts, destinations and vaults, and forgets only the selected secret', async () => {
		const secrets = new Map<string, string>();
		const app = {
			secretStorage: {
				getSecret: (key: string) => secrets.get(key),
				setSecret: (key: string, value: string) => secrets.set(key, value),
			},
		} as unknown as App;
		const store = new EncryptionKeyStorage(app);
		const scope = await encryptionScope('account', 'folder', 'vault');
		for (const changed of [
			await encryptionScope('other', 'folder', 'vault'),
			await encryptionScope('account', 'other', 'vault'),
			await encryptionScope('account', 'folder', 'other'),
		])
			expect(changed).not.toBe(scope);
		store.set(scope, 'private unlock key');
		store.set('other', 'other key');
		expect(store.get(scope)).toBe('private unlock key');
		store.forget(scope);
		expect(store.get(scope)).toBeUndefined();
		expect(store.get('other')).toBe('other key');
	});
});
