import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(process.cwd(), '..', '..');
const CAPABILITY_SNAPSHOT = join(REPO_ROOT, 'apps', 'desktop', 'src', 'main', 'capability-snapshot.ts');
const MAIN = join(REPO_ROOT, 'apps', 'desktop', 'src', 'main', 'main.ts');
const PERMISSION = join(REPO_ROOT, 'packages', 'core', 'src', 'permission.ts');

describe('Office document capability contract', () => {
  it('surfaces Office Documents as a capability backed by officecli probe', async () => {
    const [snapshot, main] = await Promise.all([
      readFile(CAPABILITY_SNAPSHOT, 'utf8'),
      readFile(MAIN, 'utf8'),
    ]);

    assert.match(snapshot, /officeDocumentsCapability\(input\.officeCliProbe, now\)/);
    assert.match(snapshot, /id:\s*'office_documents'/);
    assert.match(snapshot, /label:\s*'Office Documents'/);
    assert.match(snapshot, /officecli/);
    assert.match(snapshot, /读取、校验与生成/);
    assert.match(main, /probeOfficeCli\(\{ now: permissions\.checkedAt \}\)/);
    assert.match(main, /probeOfficeCli\(\{ now \}\)/);
  });

  it('allows only read-only officecli commands as safe shell prefixes', async () => {
    const permission = await readFile(PERMISSION, 'utf8');
    assert.match(permission, /'officecli view'/);
    assert.match(permission, /'officecli get'/);
    assert.match(permission, /'officecli query'/);
    assert.match(permission, /'officecli validate'/);
    assert.doesNotMatch(permission, /'officecli set'/);
    assert.doesNotMatch(permission, /'officecli add'/);
    assert.doesNotMatch(permission, /'officecli close'/);
  });
});
