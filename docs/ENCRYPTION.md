# Encrypted sync

OneDrive Sync can encrypt file contents and filenames locally using Cryptomator vault format 8 (`SIV_GCM`). OneDrive receives encrypted file data and encrypted names. Obsidian continues to use your normal local files. The Cryptomator app does not need to be installed or running on any device using the plugin.

## Create encrypted storage

1. Connect the plugin to a personal OneDrive account in **App Folder** mode and resolve any outstanding sync conflicts.
2. Open **Settings → OneDrive Sync → End-to-end encryption → Set up encryption**.
3. Select **Create new encrypted vault**, choose a new folder, and enter and confirm a password. The dialog displays the destination before creation. The default name is `<vault name>.cryptomator`.
4. Leave **Remember on this device** enabled for automatic unlocking after restart, or disable it to enter your password each session.
5. Choose **Start encrypted sync**. The plugin creates and verifies the vault before changing its active destination, then uploads eligible local files. Interrupted file uploads can be retried by syncing again.

Paths are relative to the OneDrive app folder. Encrypted sync currently supports personal accounts in App Folder mode only. Full Access, shared folders, and work/school accounts remain available for plaintext sync but are outside the encrypted MVP.

Existing plaintext files and OneDrive version history remain in their original location. Configure every device to use the encrypted destination; older clients pointed at a plaintext location will continue uploading plaintext there. Keep your password somewhere recoverable: a downloaded Cryptomator vault requires it even when this device remembers its unlock key.

If setup stops after creating the complete remote vault but before activating it, use **Connect existing encrypted vault** with that folder and password. If setup stops before the signed vault configuration is published, the previous destination and local files remain intact; choose a fresh destination rather than overwriting the incomplete vault's key files.

## Connect another device

Install the plugin, connect to the same personal OneDrive account in App Folder mode, and open encryption setup. Select **Connect existing encrypted vault**, enter the same remote folder and password, and start sync. The supported format is password-protected format 8 with `SIV_GCM`, a shortening threshold of 220, and the plugin's scrypt parameters. Older formats, Cryptomator Hub, and symlinks are not supported.

Use **Change encrypted vault** to create or connect to another encrypted destination. The ordinary folder picker is fixed while encryption is active. The key and sync index are bound to the account, destination and vault identity. An account or destination mismatch stops encrypted sync rather than reusing the wrong key.

## Lock and unlock

- **Lock** blocks new sync work, waits for active operations to finish, and clears the active key. It remains locked after restarting Obsidian.
- **Unlock** accepts the vault password and can remember the key for subsequent restarts.
- **Forget saved key** locks sync and removes this vault's remembered key from Obsidian SecretStorage. It does not change the password or delete remote files.

Passwords and unwrapped keys are never saved in `data.json`, debug logs or the remote vault. A remembered unlock key lives only in Obsidian SecretStorage. The plugin's own directory and debug logs retain their existing sync exclusions. Local notes and local conflict copies remain plaintext.

## Recover independently with Cryptomator

Download the **entire encrypted folder**, including `vault.cryptomator`, `masterkey.cryptomator`, and every file beneath `d/`. In Cryptomator, add an existing vault, select `vault.cryptomator`, and enter your password. All synced eligible files, settings and empty directories are represented in the standard vault structure. No plugin installation, local sync index, or plugin-specific manifest is needed.

Cryptomator is an independent recovery option. Coordinated simultaneous editing through Cryptomator and this plugin is outside this version's supported workflow.

## Sync behavior and failures

The plugin separately tracks plaintext local files and encrypted cloud versions. OneDrive's hashes describe encrypted bytes; the plugin never compares those against plaintext hashes or treats matching sizes as matching content. A first scan or reconcile decrypts content for comparison. Normal conflict strategies continue to operate on plaintext.

Cryptomator normalizes names to Unicode NFC. Existing local decomposed spellings are mapped to their canonical cloud names; two different local names that normalize identically stop sync until one is renamed.

Incorrect passwords, unsupported or damaged vault metadata, and authentication failures stop encrypted sync. Damaged content is not written over a local file. Recovery validates remote file contents before deleting local-only files. Restore damaged metadata from a known-good backup before unlocking and retrying. Sync never falls back to plaintext or silently creates replacement master keys.

As with Cryptomator itself, cloud storage can still observe ciphertext sizes, file counts and modification activity. The format does not provide a global history or rollback guarantee.

## Development verification

The optional interoperability check is separate from the normal Java-free build, test suite, and CI. Run `npm run test:interop` with Node, JDK 21 and Maven installed. It exports a complete raw vault from the TypeScript backend, then opens it using the official test-only `cryptofs` 2.8.0 reader and compares every recovered path and byte against the originals. Java is not bundled or required by the plugin. Set `MAVEN_BIN` to use a Maven executable outside `PATH`.

The regular test suite covers encryption, browser execution without Node globals, key isolation, cross-device sync, conflicts, long and Unicode names, folder moves/deletes, reset, reconcile and corruption. Live OneDrive and physical-device smoke tests require an authenticated Obsidian installation and are separate from these automated checks.
