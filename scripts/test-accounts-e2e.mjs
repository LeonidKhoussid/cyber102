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

async function chatTurn(trigger) {
  const response = page.waitForResponse(reply => reply.request().method() === 'POST' && /\/chats\/[^/]+\/turns$/.test(reply.url()));
  await trigger();
  const reply = await response;
  assert.equal(reply.status(), 200);
  const result = await reply.json();
  await page.locator('.turn').last().getByText(result.turn.response.message, { exact: true }).waitFor();
  return result;
}

function submit(message) {
  return chatTurn(async () => {
    await page.getByRole('textbox', { name: /Ваш вопрос|Продолжить поиск/u }).fill(message);
    await page.locator('#question').press('Enter');
  });
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
  const planTurn = await submit('Подбери два события в Уфе 21 ноября: поеду на машине.');
  const planChatId = planTurn.chat.id;
  const planContext = planTurn.turn.response.context;
  assert.equal(planContext.city, 'Уфа');
  assert.equal(planContext.planMode, 'day');
  assert.equal(planContext.transport, 'car');
  assert.equal(planContext.planCount, 2);
  assert.equal(planTurn.turn.response.status, 'clarify');
  assert.equal(planTurn.turn.response.events.length, 0);

  const saveOffer = () => chatTurn(async () => {
    const save = page.waitForResponse(reply => reply.request().method() === 'PUT' && reply.url().includes(`/chats/${planChatId}/event-plan/`));
    await page.locator('.turn').last().getByRole('button', { name: 'Добавить в план' }).click();
    assert.equal((await save).status(), 200);
  });
  const first = (await submit('Спектакль «Пегий пёс»')).turn.response;
  assert.equal(first.events.length, 1, first.message);
  const firstEvent = first.events[0].event;
  assert.match(firstEvent.title, /Пегий п[её]с/u);
  assert.ok(firstEvent.endsAt);
  const nextQuestion = (await saveOffer()).turn.response;
  assert.equal(nextQuestion.status, 'clarify');
  assert.equal(nextQuestion.events.length, 0);
  const next = (await submit('Потом спектакль «Щелкунчик»')).turn.response;
  assert.equal(next.events.length, 1, next.message);
  const secondEvent = next.events[0].event;
  assert.match(secondEvent.title, /Щелкунчик/u);
  assert.ok(Date.parse(secondEvent.startsAt) >= Date.parse(firstEvent.endsAt));
  await saveOffer();

  const plan = page.locator('#event-plan');
  const disclosure = plan.locator('#event-plan-toggle');
  assert.equal(await disclosure.getAttribute('aria-expanded'), 'false');
  await disclosure.click();
  await plan.getByRole('button', { name: 'Построить маршрут' }).click();
  await plan.getByRole('link', { name: 'Открыть в Яндекс Картах' }).waitFor();
  if (process.env.VERIFY_LIVE_MAP === '1') {
    const maps = plan.getByRole('region', { name: 'Маршрут в Яндекс Картах' });
    const embedded = maps.locator('iframe[title="Интерактивная карта маршрута"]');
    const sdk = maps.getByText(/в пути около/iu);
    await sdk.or(embedded).first().waitFor({ timeout: 30_000 });
    if (await embedded.isVisible()) {
      const widget = embedded.contentFrame();
      await widget.getByText('Открыть маршрут', { exact: true }).first().waitFor({ timeout: 25_000 });
      await widget.getByText(/\d+\s*мин/u).first().waitFor({ timeout: 25_000 });
      console.log('PASS live Yandex widget rendered the two catalog stops and a route estimate');
    } else {
      await plan.getByRole('list', { name: 'Отрезки маршрута' }).getByRole('listitem').waitFor();
      console.log('PASS live Yandex SDK route with two catalog stops');
    }
  }
  await page.reload();
  await disclosure.waitFor();
  assert.equal(await disclosure.getAttribute('aria-expanded'), 'false');
  await disclosure.click();
  const agenda = plan.getByRole('list', { name: 'События по времени' });
  await agenda.waitFor();
  assert.deepEqual(await agenda.getByRole('link').allTextContents(), [firstEvent.title, secondEvent.title]);
  const savedPlan = await context.request.get(`${origin}/api/v1/chats/${planChatId}/event-plan`);
  assert.equal(savedPlan.status(), 200);
  const planEvents = (await savedPlan.json()).events;
  assert.deepEqual(planEvents.map(event => event.title), [firstEvent.title, secondEvent.title]);
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
