/**
 * Loads lab definitions from the exercises folder:
 *
 *   exercises/<lab-id>/lab.json         { title, description, exercises: [{ id, title, dir }] }
 *   exercises/<lab-id>/<dir>/prompt.md  what the student reads
 *   exercises/<lab-id>/<dir>/starter.py code the student starts from
 *   exercises/<lab-id>/<dir>/tests.py   test_* functions; `from solution import ...`
 *   exercises/<lab-id>/<dir>/hints.json optional { "TypeError": "hint…", "fail:test_name": "hint…" }
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Exercise, LabDefinition } from '@labpulse/shared';

const ID_RE = /^[A-Za-z0-9_\-]{1,64}$/;

const labFileSchema = z.object({
  title: z.string().min(1),
  description: z.string().default(''),
  exercises: z
    .array(z.object({ id: z.string().regex(ID_RE), title: z.string().min(1), dir: z.string().min(1) }))
    .min(1),
});

const hintsSchema = z.record(z.string(), z.string());

export interface LabLoadResult {
  labs: LabDefinition[];
  errors: string[];
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function loadLabs(dir: string): Promise<LabLoadResult> {
  const labs: LabDefinition[] = [];
  const errors: string[] = [];
  let entries: string[];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return { labs, errors: [`Exercises folder not found: ${dir}`] };
  }

  for (const labId of entries) {
    const labDir = path.join(dir, labId);
    const labJson = await readOptional(path.join(labDir, 'lab.json'));
    if (labJson === null) continue;
    try {
      if (!ID_RE.test(labId)) throw new Error('folder name must be letters, digits, - or _');
      const parsed = labFileSchema.parse(JSON.parse(labJson));
      const ids = new Set<string>();
      const exercises: Exercise[] = [];
      for (const ex of parsed.exercises) {
        if (ids.has(ex.id)) throw new Error(`duplicate exercise id "${ex.id}"`);
        ids.add(ex.id);
        const exDir = path.resolve(labDir, ex.dir);
        if (!exDir.startsWith(path.resolve(labDir) + path.sep)) throw new Error(`exercise dir "${ex.dir}" escapes the lab folder`);
        const [prompt, starter, tests, hints] = await Promise.all([
          readOptional(path.join(exDir, 'prompt.md')),
          readOptional(path.join(exDir, 'starter.py')),
          readOptional(path.join(exDir, 'tests.py')),
          readOptional(path.join(exDir, 'hints.json')),
        ]);
        if (tests === null) throw new Error(`${ex.dir}/tests.py is missing`);
        if (!/^def\s+test_\w+\s*\(/m.test(tests)) throw new Error(`${ex.dir}/tests.py has no test_* functions`);
        exercises.push({
          id: ex.id,
          title: ex.title,
          prompt: prompt ?? '',
          starter: starter ?? '',
          tests,
          hints: hints ? hintsSchema.parse(JSON.parse(hints)) : undefined,
        });
      }
      labs.push({ id: labId, title: parsed.title, description: parsed.description, language: 'python', exercises });
    } catch (err) {
      errors.push(`Lab "${labId}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { labs, errors };
}
