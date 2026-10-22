/**
 * The 5-minute demo, end to end, in real browsers: an instructor opens a lab,
 * students join and run real Python in Pyodide, the dashboard groups the planted
 * TypeError, a broadcast hint shrinks the group, and the report adds up.
 */
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const solutions = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/solutions.json'), 'utf8')) as Record<string, Record<string, string>>;
const shots = process.env.SHOTS_DIR;
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: false });
};

async function newStudent(browser: Browser, code: string, name: string) {
  const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`/j/${code}`);
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: 'Join lab' }).click();
  await expect(page.getByText(`Connected as ${name}`)).toBeVisible();
  await expect(page.getByRole('button', { name: /Run tests/ })).toBeEnabled({ timeout: 60_000 });
  return { ctx, page };
}

async function setCode(page: Page, code: string) {
  await page.locator('.code-editor .monaco-editor textarea').first().focus();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');
  await page.evaluate((text) => navigator.clipboard.writeText(text), code);
  await page.keyboard.press('ControlOrMeta+V');
}

async function runTests(page: Page) {
  await page.getByRole('button', { name: /Run tests/ }).click();
  await expect(page.getByRole('button', { name: /Run tests/ })).toBeEnabled();
  // The result panel always re-renders as fresh (not stale) after a run.
  await expect(page.locator('.results:not([data-stale])')).toBeVisible();
}

async function openExercise(page: Page, title: string) {
  await page.getByRole('button', { name: new RegExp(title) }).click();
}

test('demo loop: group, hint, shrink, report', async ({ browser }) => {
  const contexts: BrowserContext[] = [];
  const teacherCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  contexts.push(teacherCtx);
  const t = await teacherCtx.newPage();

  // Home page and sign-up.
  await t.goto('/');
  await shot(t, '01-home');
  await t.goto('/teach');
  await expect(t).toHaveURL(/sign-in/);
  await t.getByRole('button', { name: 'Create an account' }).click();
  await t.getByLabel('Name').fill('Priya Sharma');
  await t.getByLabel('Email').fill(`priya+${Date.now()}@college.edu`);
  await t.getByLabel('Password').fill('labpulse-demo');
  await t.getByRole('button', { name: 'Create account' }).click();
  await expect(t.getByRole('heading', { name: 'Start a lab' })).toBeVisible();
  await t.getByLabel('Session name').fill('CSE 2B, Lab 4');
  await t.getByLabel(/Flag a student as stuck/).selectOption('2');
  await shot(t, '02-start-lab');
  await t.getByRole('button', { name: 'Open the lab' }).click();

  // Empty room shows the join screen with the code.
  await expect(t.getByText('Waiting for the first student')).toBeVisible();
  const code = (await t.locator('.dash-code-value').textContent())!.trim();
  expect(code).toMatch(/^[A-Z2-9]{6}$/);
  await shot(t, '03-join-screen');

  // Students join and work.
  const names = ['Ravi Kumar', 'Meera Iyer', 'Arjun Rao', 'Sneha Patil'];
  const students: Page[] = [];
  for (const n of names) {
    const s = await newStudent(browser, code, n);
    contexts.push(s.ctx);
    students.push(s.page);
  }
  const [ravi, meera, arjun, sneha] = students as [Page, Page, Page, Page];
  await shot(ravi, '04-student-editor');

  // Everyone solves exercise 1.
  for (const s of students) {
    await setCode(s, solutions['class-average']!.correct!);
    await runTests(s);
    await expect(s.locator('.results-head h2')).toHaveText('All 3 tests pass');
  }

  // Exercise 2: three run the planted bug as-is; Sneha fixes it straight away.
  for (const s of [ravi, meera, arjun]) {
    await openExercise(s, 'Receipt line');
    await runTests(s);
    await expect(s.locator('.results-head h2')).toHaveText('TypeError on line 4');
  }
  await shot(ravi, '05-student-error');
  await openExercise(sneha, 'Receipt line');
  await setCode(sneha, solutions['receipt-line']!.correct!);
  await runTests(sneha);
  await expect(sneha.locator('.results-head h2')).toHaveText('All 3 tests pass');

  // Dashboard: one group of 3 on the TypeError.
  const group = t.locator('.group-card', { hasText: 'Receipt line' }).first();
  await expect(group.locator('.group-count')).toHaveText('3');
  await expect(group).toContainText("TypeError: unsupported operand type(s) for +: 'int' and 'str'");
  await expect(group).toContainText('Ravi Kumar');
  await expect(t.locator('.summary-item').first()).toContainText('4');
  await shot(t, '06-dashboard-group');

  // Projector mode hides names.
  await t.getByText('Hide names').click();
  await expect(group).not.toContainText('Ravi Kumar');
  await shot(t, '07-dashboard-projector');
  await t.getByText('Hide names').click();

  // Broadcast a hint to the group.
  await group.getByRole('button', { name: /Send a hint/ }).click();
  await expect(group.locator('textarea')).toHaveValue(/str\(quantity\)/);
  await group.getByRole('button', { name: 'Send to 3 students' }).click();
  await expect(t.getByText('Hint sent to 3 students')).toBeVisible();
  for (const s of [ravi, meera, arjun]) await expect(s.locator('.hint-card-text')).toContainText('str(quantity)');
  await expect(sneha.locator('.hint-card')).toHaveCount(0);
  await shot(ravi, '08-student-hint');

  // Two fix it, one half-fixes it into a different TypeError: the group shrinks 3 -> 1... then moves.
  await setCode(ravi, solutions['receipt-line']!.correct!);
  await runTests(ravi);
  await setCode(meera, solutions['receipt-line']!.correct!);
  await runTests(meera);
  await expect(group.locator('.group-count')).toHaveText('1');
  await expect(group.locator('.hint-effect-numbers')).toContainText('3');
  await expect(group.locator('.hint-effect-numbers')).toContainText('1');
  await shot(t, '09-dashboard-shrunk');

  await setCode(arjun, solutions['receipt-line']!.half_fixed!);
  await runTests(arjun);
  await expect(arjun.locator('.results-head h2')).toHaveText('TypeError on line 3');

  // Arjun waits: stuck detection after 2 minutes without a passing run.
  await expect(t.locator('.stuck-row', { hasText: 'Arjun Rao' })).toBeVisible({ timeout: 150_000 });
  await expect(t.locator('.stuck-row', { hasText: 'Arjun Rao' })).toContainText('No passing run for');
  await shot(t, '10-dashboard-stuck');

  // End the lab and read the report.
  await t.getByRole('button', { name: 'End lab' }).click();
  await t.getByRole('button', { name: 'End lab and see report' }).click();
  await expect(t).toHaveURL(/report/);
  await expect(t.locator('.report-lead')).toHaveText('Receipt line lost 1 of the 4 students who tried it (25%).');
  await expect(t.locator('.funnel li').nth(1)).toContainText('3 of 4 finished');
  await expect(t.locator('.top-errors li').first()).toContainText('3 students');
  await expect(t.locator('.hint-report')).toContainText('Sent to 3 students; 2 passed within 5 minutes');
  await shot(t, '11-report');
  await t.screenshot({ path: shots ? path.join(shots, '11b-report-full.png') : undefined, fullPage: true });

  // Students are told the lab ended.
  await expect(ravi.getByText('The lab has ended')).toBeVisible();

  for (const c of contexts) await c.close();
});
