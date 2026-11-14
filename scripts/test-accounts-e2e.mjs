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

  const openSidebar = page.getByRole('button', { name: 'История поиска', exact: true });
  const closeSidebar = page.getByRole('button', { name: 'Закрыть историю', exact: true });
  await closeSidebar.click();
  await history.waitFor({ state: 'hidden' });
  assert.equal(await openSidebar.evaluate(button => document.activeElement === button), true);
  assert.equal(new URL(page.url()).searchParams.get('chat'), chatId);
  await openSidebar.press('Enter');
  await history.waitFor();
  await history.getByRole('button', { name: 'Семейное кино', exact: true }).waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  await openSidebar.click();
  const drawer = page.getByRole('dialog');
  await drawer.getByRole('button', { name: 'Закрыть историю', exact: true }).click();
  await drawer.waitFor({ state: 'hidden' });
  await openSidebar.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Семейное кино', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.getByRole('button', { name: 'Новый поиск', exact: true }).click();
  const planTurn = await submit('Подбери два события в Уфе 21 ноября: поеду на машине. Точка отправления: 54.736, 55.958');
  const planChatId = planTurn.chat.id;
  const planContext = planTurn.turn.response.context;
  assert.equal(planContext.city, 'Уфа');
  assert.equal(planContext.planMode, 'day');
  assert.equal(planContext.transport, 'car');
  assert.equal(planContext.planCount, 2);
  const card = page.locator('.turn').last().locator('.event-card');
  const cards = await card.count();
  assert.ok(cards >= 2, JSON.stringify(planTurn.turn.response));
  const savedTitles = [];
  for (const index of [1, 0]) {
    savedTitles.push((await card.nth(index).getByRole('heading', { level: 3 }).innerText()).trim());
    const response = page.waitForResponse(reply => reply.request().method() === 'PUT' && reply.url().includes(`/chats/${planChatId}/event-plan/`));
    await card.nth(index).getByRole('button', { name: 'Добавить в план' }).click();
    assert.equal((await response).status(), 200);
  }
  const plan = page.getByRole('region', { name: 'План дня', exact: true });
  await plan.getByText('2 из 4', { exact: true }).waitFor();
  await plan.getByRole('link', { name: 'Открыть в Яндекс Картах' }).waitFor();
  if (process.env.VERIFY_LIVE_MAP === '1') {
    const maps = plan.getByRole('region', { name: 'Маршрут в Яндекс Картах' });
    await maps.getByText(/в пути около/iu).waitFor({ timeout: 30_000 }).catch(async error => {
      throw new Error(`Live Yandex route did not calculate: ${await maps.innerText()}`, { cause: error });
    });
    assert.equal(await plan.getByRole('list', { name: 'Отрезки маршрута' }).getByRole('listitem').count(), 2);
    console.log('PASS live Yandex route with two catalog stops');
  }
  await page.reload();
  await plan.getByText('2 из 4', { exact: true }).waitFor();
  const savedPlan = await context.request.get(`${origin}/api/v1/chats/${planChatId}/event-plan`);
  assert.equal(savedPlan.status(), 200);
  const planEvents = (await savedPlan.json()).events;
  assert.deepEqual(planEvents.map(event => event.title).sort(), savedTitles.sort());
  assert.ok(planEvents.every(event => event.city === 'Уфа' && event.sources.length > 0));
  await page.getByRole('button', { name: /^Удалить поиск: Подбери два события/u }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Удалить', exact: true }).click();
  await history.getByRole('button', { name: /^Подбери два события/u }).waitFor({ state: 'hidden' });
  assert.equal((await context.request.get(`${origin}/api/v1/chats/${planChatId}/event-plan`)).status(), 404);

  await page.getByRole('button', { name: 'Удалить поиск: Семейное кино' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Удалить', exact: true }).click();
  await history.getByRole('button', { name: 'Семейное кино', exact: true }).waitFor({ state: 'hidden' });
  assert.equal((await context.request.get(origin + '/api/v1/chats/' + chatId)).status(), 404);
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  console.log('PASS registration, history, reload, rename, login, mobile sidebar, day plan with live catalog and persisted stops, deletion');
} finally {
  await browser.close();
}
