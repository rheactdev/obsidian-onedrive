import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const location = mkdtempSync(join(tmpdir(), 'onedrive-cryptomator-interop-'));
const env = { ...process.env, CRYPTOMATOR_EXPORT_PATH: location };
function run(command, args) {
	const result = spawnSync(command, args, { env, stdio: 'inherit' });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}
try {
	run(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'tests/interop/export.test.ts']);
	run(process.env.MAVEN_BIN || 'mvn', [
		'-q',
		'-f',
		'tests/interop/pom.xml',
		`-Dmaven.repo.local=${join(tmpdir(), 'onedrive-cryptomator-maven-cache')}`,
		'test',
	]);
} finally {
	rmSync(location, { recursive: true, force: true });
}
