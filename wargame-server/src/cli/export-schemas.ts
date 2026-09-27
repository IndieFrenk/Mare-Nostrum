import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import * as S from '../schemas/index.js';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../schemas-json');
mkdirSync(out, { recursive: true });
for (const [name, schema] of Object.entries(S)) {
  if (!(schema instanceof z.ZodType)) continue;
  writeFileSync(path.join(out, `${name}.schema.json`), JSON.stringify(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }), null, 1));
}
console.log(`JSON Schema esportati in ${out}`);
