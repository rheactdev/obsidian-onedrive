import type { App } from 'obsidian';

/** Keys are local to this installation and never part of plugin settings or sync payloads. */
export class EncryptionKeyStorage {
	constructor(private app: App) {}
	get(scope: string): string | undefined {
		return this.app.secretStorage.getSecret(`onedrive-e2ee-${scope}`) || undefined;
	}
	set(scope: string, key: string): void {
		this.app.secretStorage.setSecret(`onedrive-e2ee-${scope}`, key);
	}
	forget(scope: string): void {
		this.app.secretStorage.setSecret(`onedrive-e2ee-${scope}`, '');
	}
}

export async function encryptionScope(
	account: string,
	destination: string,
	vaultId: string
): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify([account, destination, vaultId]));
	const hash = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}
