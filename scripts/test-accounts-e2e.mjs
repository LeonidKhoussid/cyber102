import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';

const origin = process.env.WEB_ORIGIN || 'http://localhost:3000';
const email = 'afisha-e2e-' + randomUUID() + '@example.test';
const password = randomUUID();
const question = 'Фильм «Чудо-Юдо» 15 ноября в Уфе с ребёнком 6 лет до 420 рублей на двоих.';
const followup = 'А если бюджет только 419 рублей?';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, headless: true });
const context = await browser.newContext();
const page = await context.newPage();

async function submit(message) {
  const response = page.waitForResponse(reply => reply.request().method() === 'POST' && /\/chats\/[^/]+\/turns$/.test(reply.url()));
  await page.getByRole('textbox', { name: /Ваш вопрос|Продолжить поиск/u }).fill(message);
  await page.locator('#question').press('Enter');
  const reply = await response;
  assert.equal(reply.status(), 200);
  const result = await reply.json();
  await page.locator('.turn').last().getByText(result.turn.response.message, { exact: true }).waitFor();
  return result;
}

async function credentials(target, name) {
  if (name) await target.getByLabel('Имя', { exact: true }).fill(name);
  await target.getByLabel('Электронная почта', { exact: true }).fill(email);
  await target.getByLabel('Пароль', { exact: true }).fill(password);
}

try {
  await page.goto(origin + '/register');
  const register = page.getByRole('dialog');
  await credentials(register, 'Проверка истории');
  await register.getByRole('button', { name: 'Зарегистрироваться', exact: true }).click();
  await page.getByRole('navigation', { name: 'История поиска' }).waitFor();
  const saved = await submit(question);
  assert.equal(saved.turn.response.context.budget, 420);
  const chatId = saved.chat.id;
  await page.reload();
  await page.locator('.turn').last().getByText(saved.turn.response.message, { exact: true }).waitFor();

  const second = await submit(followup);
  assert.equal(second.turn.response.context.budget, 419);
  assert.equal(second.turn.response.context.partySize, 2);
  assert.equal(second.turn.response.context.city, 'Уфа');

  await page.getByRole('button', { name: /^Переименовать поиск:/u }).click();
  const rename = page.getByRole('dialog');
  await rename.getByLabel('Название поиска').fill('Семейное кино');
  await rename.getByRole('button', { name: 'Сохранить', exact: true }).click();
  const history = page.getByRole('navigation', { name: 'История поиска' });
  await history.getByRole('button', { name: 'Семейное кино', exact: true }).waitFor();

  await page.getByRole('button', { name: 'Новый поиск', exact: true }).click();
  await history.getByRole('button', { name: 'Семейное кино', exact: true }).click();
  await page.locator('.question').last().filter({ hasText: followup }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('chat'), chatId);

  const foreign = await browser.newContext();
  try {
    const denied = await foreign.request.get(origin + '/api/v1/chats/' + chatId);
    assert.equal(denied.status(), 401);
  } finally { await foreign.close(); }

  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await history.waitFor({ state: 'hidden' });
  await page.goto(origin + '/login');
  const login = page.getByRole('dialog');
  await credentials(login);
  await login.getByRole('button', { name: 'Войти', exact: true }).click();
  await history.getByRole('button', { name: 'Семейное кино', exact: true }).click();
  await page.locator('.question').last().filter({ hasText: followup }).waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'История поиска', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Семейное кино', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.getByRole('button', { name: 'Удалить поиск: Семейное кино' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Удалить', exact: true }).click();
  await history.getByRole('button', { name: 'Семейное кино', exact: true }).waitFor({ state: 'hidden' });
  assert.equal((await context.request.get(origin + '/api/v1/chats/' + chatId)).status(), 404);
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  console.log('PASS registration, saved search and follow-up, reload, rename, logout, login, mobile history and delete');
} finally {
  await browser.close();
}
