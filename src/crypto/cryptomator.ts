/** Cryptomator format 8 / SIV_GCM. No Node APIs: this also runs in mobile WebViews. */
import { AES } from '@stablelib/aes';
import { SIV } from '@stablelib/siv';
import { Scrypt } from '@stablelib/scrypt';
import { base32, base64, base64url } from '@scure/base';

const utf8 = new TextEncoder();
const text = new TextDecoder('utf-8', { fatal: true });
export const CHUNK_SIZE = 32768;
const HEADER_SIZE = 68;
const CHUNK_OVERHEAD = 28;

export class EncryptionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'EncryptionError';
	}
}

export function buffer(bytes: Uint8Array): ArrayBuffer {
	return Uint8Array.from(bytes).buffer;
}
function subtle(): SubtleCrypto {
	if (typeof crypto === 'undefined' || !crypto.subtle || !crypto.getRandomValues) {
		throw new EncryptionError('Encrypted sync requires Web Crypto on this device.');
	}
	return crypto.subtle;
}
function random(size: number): Uint8Array {
	subtle();
	return crypto.getRandomValues(new Uint8Array(size));
}
function join(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}
function url64(bytes: Uint8Array): string {
	return base64url.encode(bytes).replace(/=+$/, '');
}
function decode64(value: string): Uint8Array {
	if (typeof value !== 'string') throw new EncryptionError('Invalid vault encoding.');
	return base64url.decode(value + '='.repeat((4 - (value.length % 4)) % 4));
}
async function aesKey(raw: Uint8Array, algorithm = 'AES-GCM'): Promise<CryptoKey> {
	return subtle().importKey(
		'raw',
		buffer(raw),
		algorithm,
		true,
		algorithm === 'AES-KW' ? ['wrapKey', 'unwrapKey'] : ['encrypt', 'decrypt']
	);
}
async function sign(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
	const k = await subtle().importKey('raw', buffer(key), { name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign',
	]);
	return new Uint8Array(await subtle().sign('HMAC', k, buffer(data)));
}
async function verify(key: Uint8Array, data: Uint8Array, signature: Uint8Array): Promise<boolean> {
	const k = await subtle().importKey('raw', buffer(key), { name: 'HMAC', hash: 'SHA-256' }, false, [
		'verify',
	]);
	return subtle().verify('HMAC', k, buffer(signature), buffer(data));
}

export interface VaultConfig {
	format: 8;
	cipherCombo: 'SIV_GCM';
	shorteningThreshold: number;
	jti: string;
}
interface MasterkeyFile {
	version: number;
	scryptSalt: string;
	scryptCostParam: number;
	scryptBlockSize: number;
	primaryMasterKey: string;
	hmacMasterKey: string;
	versionMac: string;
}

export class CryptomatorCryptor {
	private alive = true;
	private constructor(
		private key: Uint8Array,
		readonly config: VaultConfig
	) {}
	private assertOpen(): void {
		if (!this.alive)
			throw new EncryptionError('Encrypted sync is locked. Unlock it in OneDrive Sync settings.');
	}
	exportKey(): string {
		this.assertOpen();
		return base64.encode(this.key);
	}
	destroy(): void {
		this.key.fill(0);
		this.alive = false;
	}

	static async fromKey(configToken: string, encodedKey: string): Promise<CryptomatorCryptor> {
		let key: Uint8Array = new Uint8Array(0);
		try {
			key = base64.decode(encodedKey);
			if (key.length !== 64 || configToken.length > 16384) throw new Error();
			const [headerPart, payloadPart, signature, extra] = configToken.trim().split('.');
			const header = JSON.parse(text.decode(decode64(headerPart))) as Record<string, unknown>;
			if (extra || header.alg !== 'HS256' || header.kid !== 'masterkeyfile:masterkey.cryptomator')
				throw new Error();
			if (!(await verify(key, utf8.encode(`${headerPart}.${payloadPart}`), decode64(signature))))
				throw new Error();
			const config = JSON.parse(text.decode(decode64(payloadPart))) as VaultConfig;
			if (
				config.format !== 8 ||
				config.cipherCombo !== 'SIV_GCM' ||
				config.shorteningThreshold !== 220 ||
				typeof config.jti !== 'string' ||
				!config.jti
			)
				throw new Error();
			return new CryptomatorCryptor(key, config);
		} catch {
			key.fill(0);
			throw new EncryptionError(
				'Invalid or unsupported Cryptomator vault configuration or unlock key.'
			);
		}
	}

	static async unlock(
		config: string,
		masterkeyJson: string,
		password: string
	): Promise<CryptomatorCryptor> {
		let kek: Uint8Array | undefined;
		let raw: Uint8Array | undefined;
		try {
			if (masterkeyJson.length > 16384) throw new Error();
			const file = JSON.parse(masterkeyJson) as MasterkeyFile;
			// Validate before allocating memory; v1 supports the parameters used by this plugin.
			if (file.version !== 999 || file.scryptCostParam !== 32768 || file.scryptBlockSize !== 8)
				throw new Error();
			const salt = base64.decode(file.scryptSalt);
			if (salt.length < 8 || salt.length > 64) throw new Error();
			const scrypt = new Scrypt(32768, 8, 1);
			const pass = utf8.encode(password.normalize('NFC'));
			try {
				kek = await scrypt.deriveKeyNonBlocking(pass, salt, 32);
			} finally {
				scrypt.clean();
				pass.fill(0);
			}
			const wrappingKey = await aesKey(kek, 'AES-KW');
			const unwrap = async (value: string) => {
				const wrapped = base64.decode(value);
				if (wrapped.length !== 40) throw new Error();
				const key = await subtle().unwrapKey(
					'raw',
					buffer(wrapped),
					wrappingKey,
					'AES-KW',
					'AES-GCM',
					true,
					['encrypt', 'decrypt']
				);
				return new Uint8Array(await subtle().exportKey('raw', key));
			};
			const enc = await unwrap(file.primaryMasterKey);
			let mac: Uint8Array | undefined;
			try {
				mac = await unwrap(file.hmacMasterKey);
				raw = join(enc, mac);
			} finally {
				enc.fill(0);
				mac?.fill(0);
			}
			const version = new Uint8Array(4);
			new DataView(version.buffer).setUint32(0, 999);
			if (!(await verify(raw.subarray(32), version, base64.decode(file.versionMac))))
				throw new Error();
			return await CryptomatorCryptor.fromKey(config, base64.encode(raw));
		} catch {
			throw new EncryptionError(
				'Unable to unlock encrypted sync. Check the password and vault files.'
			);
		} finally {
			kek?.fill(0);
			raw?.fill(0);
		}
	}

	static async create(
		password: string
	): Promise<{ cryptor: CryptomatorCryptor; config: string; masterkey: string }> {
		if (!password) throw new EncryptionError('Enter a vault password.');
		const key = random(64);
		const salt = random(16);
		const scrypt = new Scrypt(32768, 8, 1);
		const pass = utf8.encode(password.normalize('NFC'));
		let kek: Uint8Array | undefined;
		try {
			kek = await scrypt.deriveKeyNonBlocking(pass, salt, 32);
			const wrappingKey = await aesKey(kek, 'AES-KW');
			const wrap = async (raw: Uint8Array) =>
				base64.encode(
					new Uint8Array(await subtle().wrapKey('raw', await aesKey(raw), wrappingKey, 'AES-KW'))
				);
			const version = new Uint8Array(4);
			new DataView(version.buffer).setUint32(0, 999);
			const masterkey: MasterkeyFile = {
				version: 999,
				scryptSalt: base64.encode(salt),
				scryptCostParam: 32768,
				scryptBlockSize: 8,
				primaryMasterKey: await wrap(key.subarray(0, 32)),
				hmacMasterKey: await wrap(key.subarray(32)),
				versionMac: base64.encode(await sign(key.subarray(32), version)),
			};
			// UUID generated from the platform CSPRNG (randomUUID isn't present in all mobile WebViews).
			const uuid = random(16);
			uuid[6] = (uuid[6] & 15) | 64;
			uuid[8] = (uuid[8] & 63) | 128;
			const hex = Array.from(uuid, (b) => b.toString(16).padStart(2, '0')).join('');
			const jti = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
			const config: VaultConfig = {
				format: 8,
				cipherCombo: 'SIV_GCM',
				shorteningThreshold: 220,
				jti,
			};
			const unsigned = `${url64(utf8.encode(JSON.stringify({ kid: 'masterkeyfile:masterkey.cryptomator', typ: 'JWT', alg: 'HS256' })))}.${url64(utf8.encode(JSON.stringify(config)))}`;
			const token = `${unsigned}.${url64(await sign(key, utf8.encode(unsigned)))}`;
			return {
				cryptor: new CryptomatorCryptor(Uint8Array.from(key), config),
				config: token,
				masterkey: JSON.stringify(masterkey),
			};
		} finally {
			key.fill(0);
			kek?.fill(0);
			pass.fill(0);
			scrypt.clean();
		}
	}

	private siv(): SIV {
		this.assertOpen();
		// RFC 5297 takes MAC || encryption key; the vault/JWT masterkey uses the reverse order.
		const key = join(this.key.subarray(32), this.key.subarray(0, 32));
		try {
			return new SIV(AES, key);
		} finally {
			key.fill(0);
		}
	}
	encryptName(name: string, parentId: string): string {
		const siv = this.siv();
		try {
			return (
				base64url.encode(siv.seal([utf8.encode(parentId)], utf8.encode(name.normalize('NFC')))) +
				'.c9r'
			);
		} finally {
			siv.clean();
		}
	}
	decryptName(name: string, parentId: string): string {
		const siv = this.siv();
		try {
			if (!name.endsWith('.c9r')) throw new Error();
			const result = siv.open([utf8.encode(parentId)], decode64(name.slice(0, -4)));
			if (!result) throw new Error();
			const value = text.decode(result);
			if (!value || value === '.' || value === '..' || /[\\/]/.test(value) || value.includes('\0'))
				throw new Error();
			return value;
		} catch {
			throw new EncryptionError('Encrypted filename authentication failed. Sync was paused.');
		} finally {
			siv.clean();
		}
	}
	async directoryPath(id: string): Promise<string> {
		const siv = this.siv();
		try {
			const digest = await subtle().digest('SHA-1', buffer(siv.seal([], utf8.encode(id))));
			const hash = base32.encode(new Uint8Array(digest));
			return `d/${hash.slice(0, 2)}/${hash.slice(2)}`;
		} finally {
			siv.clean();
		}
	}
	async storageName(ciphertextName: string): Promise<string> {
		if (ciphertextName.length <= 220) return ciphertextName;
		return (
			base64url.encode(
				new Uint8Array(await subtle().digest('SHA-1', buffer(utf8.encode(ciphertextName))))
			) + '.c9s'
		);
	}
	static plaintextSize(ciphertextSize: number): number {
		const body = ciphertextSize - HEADER_SIZE;
		if (
			!Number.isSafeInteger(body) ||
			body < 0 ||
			(body % (CHUNK_SIZE + CHUNK_OVERHEAD) > 0 &&
				body % (CHUNK_SIZE + CHUNK_OVERHEAD) <= CHUNK_OVERHEAD)
		) {
			throw new EncryptionError('Malformed encrypted file size. Sync was paused.');
		}
		return body - Math.ceil(body / (CHUNK_SIZE + CHUNK_OVERHEAD)) * CHUNK_OVERHEAD;
	}
	async encrypt(content: ArrayBuffer): Promise<ArrayBuffer> {
		this.assertOpen();
		const plain = new Uint8Array(content);
		const nonce = random(12),
			contentKey = random(32);
		const payload = new Uint8Array(40);
		payload.fill(255, 0, 8);
		payload.set(contentKey, 8);
		try {
			const encryptedHeader = new Uint8Array(
				await subtle().encrypt(
					{ name: 'AES-GCM', iv: buffer(nonce) },
					await aesKey(this.key.subarray(0, 32)),
					buffer(payload)
				)
			);
			const out = new Uint8Array(
				HEADER_SIZE + plain.length + Math.ceil(plain.length / CHUNK_SIZE) * CHUNK_OVERHEAD
			);
			out.set(nonce);
			out.set(encryptedHeader, 12);
			const fileKey = await aesKey(contentKey);
			for (
				let pos = 0, index = 0, dest = HEADER_SIZE;
				pos < plain.length;
				pos += CHUNK_SIZE, index++
			) {
				const iv = random(12),
					aad = chunkAad(index, nonce);
				const encrypted = new Uint8Array(
					await subtle().encrypt(
						{ name: 'AES-GCM', iv: buffer(iv), additionalData: buffer(aad) },
						fileKey,
						buffer(plain.subarray(pos, pos + CHUNK_SIZE))
					)
				);
				out.set(iv, dest);
				out.set(encrypted, dest + 12);
				dest += 12 + encrypted.length;
			}
			return out.buffer;
		} finally {
			payload.fill(0);
			contentKey.fill(0);
		}
	}
	async decrypt(content: ArrayBuffer): Promise<ArrayBuffer> {
		this.assertOpen();
		const out = new Uint8Array(CryptomatorCryptor.plaintextSize(content.byteLength));
		let header: Uint8Array | undefined;
		try {
			const bytes = new Uint8Array(content),
				nonce = bytes.subarray(0, 12);
			header = new Uint8Array(
				await subtle().decrypt(
					{ name: 'AES-GCM', iv: buffer(nonce) },
					await aesKey(this.key.subarray(0, 32)),
					buffer(bytes.subarray(12, HEADER_SIZE))
				)
			);
			const fileKey = await aesKey(header.subarray(8));
			for (
				let pos = HEADER_SIZE, index = 0, dest = 0;
				pos < bytes.length;
				pos += CHUNK_SIZE + CHUNK_OVERHEAD, index++
			) {
				const chunk = bytes.subarray(pos, pos + CHUNK_SIZE + CHUNK_OVERHEAD);
				const plain = new Uint8Array(
					await subtle().decrypt(
						{
							name: 'AES-GCM',
							iv: buffer(chunk.subarray(0, 12)),
							additionalData: buffer(chunkAad(index, nonce)),
						},
						fileKey,
						buffer(chunk.subarray(12))
					)
				);
				out.set(plain, dest);
				dest += plain.length;
				plain.fill(0);
			}
			return out.buffer;
		} catch {
			out.fill(0);
			throw new EncryptionError(
				'Encrypted file authentication failed. Local files have not been replaced.'
			);
		} finally {
			header?.fill(0);
		}
	}
}

function chunkAad(index: number, headerNonce: Uint8Array): Uint8Array {
	const aad = new Uint8Array(20),
		view = new DataView(aad.buffer);
	view.setUint32(0, Math.floor(index / 0x100000000));
	view.setUint32(4, index >>> 0);
	aad.set(headerNonce, 8);
	return aad;
}
