import { resolveStorageRoot, StorageRootAuthorityError } from '../../root-authority.js';

const [root] = process.argv.slice(2);
if (!root || !process.send) throw new Error('usage: root-resolver <root>');

try {
  await resolveStorageRoot({ path: root, kind: 'interactive' });
  await send({ type: 'resolved' });
} catch (error) {
  await send({
    type: 'error',
    code: error instanceof StorageRootAuthorityError ? error.code : 'unexpected',
  });
}
process.disconnect?.();

function send(message: object): Promise<void> {
  return new Promise((resolve, reject) => {
    process.send?.(message, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
