import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Fixtures } from './build';

export const FIXTURES_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'docs', 'design', 'fixtures');

export function loadFixtures(dir = FIXTURES_DIR): Fixtures {
  const read = (f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>;
  return { operators: read('operators.json'), trust: read('trust.json'), commerceUsers: read('commerce-users.json') };
}
