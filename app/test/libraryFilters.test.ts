import { describe, expect, it } from 'vitest'
import { parseFilters } from '../src/main/library/filters'
import { questionKind } from '../src/main/library/kind'

// Wednesday 5 November 2026, 15:30 local time
const now = new Date(2026, 10, 4, 15, 30).getTime()
const day = (y: number, m: number, d: number) => new Date(y, m, d).getTime()
const names = ['Tarun Shah', 'Ann Lee', 'Ann Smith', 'Will Ford', 'Bo Park']
const f = (q: string) => parseFilters(q, { now, names })

describe('dates in a question', () => {
  it('today, yesterday, this week, last week, this month, last month', () => {
    expect(f('what did we say today?')).toMatchObject({ from: day(2026, 10, 4), to: day(2026, 10, 5) })
    expect(f('Yesterday')).toMatchObject({ from: day(2026, 10, 3), to: day(2026, 10, 4) })
    // weeks start on Monday
    expect(f('my to-dos this week')).toMatchObject({ from: day(2026, 10, 2), to: day(2026, 10, 9) })
    expect(f('what happened last week')).toMatchObject({ from: day(2026, 9, 26), to: day(2026, 10, 2) })
    expect(f('decisions this month')).toMatchObject({ from: day(2026, 10, 1), to: day(2026, 11, 1) })
    expect(f('decisions last month')).toMatchObject({ from: day(2026, 9, 1), to: day(2026, 10, 1) })
  })
  it('a month by name: this year, or last year when it has not come yet; a day of it', () => {
    expect(f('what did Bo say in October?')).toMatchObject({ from: day(2026, 9, 1), to: day(2026, 10, 1) })
    expect(f('the plan from december')).toMatchObject({ from: day(2025, 11, 1), to: day(2026, 0, 1) })
    expect(f('notes from October 12')).toMatchObject({ from: day(2026, 9, 12), to: day(2026, 9, 13) })
    // "may" as a word is not a month
    expect(f('may I see the budget?').from).toBeUndefined()
  })
  it('a weekday: the latest one, today included; "last" leaves today out', () => {
    expect(f('on Monday')).toMatchObject({ from: day(2026, 10, 2), to: day(2026, 10, 3) })
    expect(f("Wednesday's standup")).toMatchObject({ from: day(2026, 10, 4), to: day(2026, 10, 5) })
    expect(f('last wednesday')).toMatchObject({ from: day(2026, 9, 28), to: day(2026, 9, 29) })
  })
  it('the last few days', () => {
    expect(f('in the past 3 days')).toMatchObject({ from: now - 3 * 86_400_000, to: now })
    expect(f('over the last 10 days')).toMatchObject({ from: now - 10 * 86_400_000, to: now })
  })
  it('takes the date words out of what is searched for', () => {
    expect(f('what did we decide about pricing last week?').rest).toBe('what did we decide about pricing?')
    expect(f('pricing').from).toBeUndefined()
  })
})

describe('people in a question', () => {
  it('by full name or first name, any case, with or without an s', () => {
    expect(f('what did Tarun Shah say about pricing?').people).toEqual(['Tarun Shah'])
    expect(f("tarun's take on pricing").people).toEqual(['Tarun Shah'])
    expect(f('what did Ann think?').people).toEqual(['Ann Lee', 'Ann Smith'])
    expect(f('meetings with Bo and Tarun').people).toEqual(['Bo Park', 'Tarun Shah'])
  })
  it('a first name that is an everyday word counts only when written with a capital', () => {
    expect(f('will we ship on time?').people).toEqual([])
    expect(f('what did Will say?').people).toEqual(['Will Ford'])
  })
})

describe('Russian relative dates', () => {
  it.each([
    ['Что решили сегодня?', day(2026, 10, 4), day(2026, 10, 5), 'Что решили?'],
    ['Итоги встреч за вчера', day(2026, 10, 3), day(2026, 10, 4), 'Итоги встреч'],
    ['Мои задачи на этой неделе', day(2026, 10, 2), day(2026, 10, 9), 'Мои задачи'],
    ['Задачи за эту неделю', day(2026, 10, 2), day(2026, 10, 9), 'Задачи'],
    ['Что решили на прошлой неделе?', day(2026, 9, 26), day(2026, 10, 2), 'Что решили?'],
    ['Итоги за прошлую неделю', day(2026, 9, 26), day(2026, 10, 2), 'Итоги'],
    ['Решения за предыдущую неделю', day(2026, 9, 26), day(2026, 10, 2), 'Решения'],
    ['Итоги встреч за этот месяц', day(2026, 10, 1), day(2026, 11, 1), 'Итоги встреч'],
    ['Что мы решили в текущем месяце?', day(2026, 10, 1), day(2026, 11, 1), 'Что мы решили?'],
    ['Договорённости за прошлый месяц', day(2026, 9, 1), day(2026, 10, 1), 'Договорённости'],
    ['Обзор встреч в прошлом месяце', day(2026, 9, 1), day(2026, 10, 1), 'Обзор встреч'],
    ['СВОДКА ЗА ПРЕДЫДУЩИЙ МЕСЯЦ', day(2026, 9, 1), day(2026, 10, 1), 'СВОДКА'],
  ])('narrows %s to local calendar boundaries and removes the date phrase', (question, from, to, rest) => {
    expect(f(question)).toMatchObject({ from, to, rest })
  })

  it('handles a previous month across a year boundary', () => {
    expect(parseFilters('Итоги за прошлый месяц', { now: day(2027, 0, 3), names: [] }))
      .toMatchObject({ from: day(2026, 11, 1), to: day(2027, 0, 1), rest: 'Итоги' })
  })

  it('does not mistake substrings for Russian dates or alter Cyrillic names', () => {
    for (const question of ['позавчера', 'сегодняшний бюджет', 'псевдопрошлой неделе', 'за прошлый месяцами']) {
      expect(f(question).from).toBeUndefined()
      expect(f(question).rest).toBe(question)
    }
    expect(parseFilters('Что сказала Елена Соловьёва вчера?', { now, names: ['Елена Соловьёва'] }))
      .toMatchObject({ people: ['Елена Соловьёва'], rest: 'Что сказала Елена Соловьёва?', from: day(2026, 10, 3), to: day(2026, 10, 4) })
  })
})

describe('the kind of question', () => {
  const k = (q: string) => questionKind(q, f(q))
  it('finding what was said is "find"', () => {
    expect(k('what did Tarun say about pricing?')).toBe('find')
    expect(k('when is the launch?')).toBe('find')
    expect(k('who mentioned the contractor')).toBe('find')
  })
  it('gathering across meetings is "across"', () => {
    expect(k('my to-dos this week')).toBe('across')
    expect(k('all my action items this month')).toBe('across')
    expect(k('what did we decide last week?')).toBe('across')
    expect(k('Summarize my meetings from yesterday')).toBe('across')
    expect(k('what are my next steps?')).toBe('across')
    expect(k('recap of this week')).toBe('across')
  })
  it.each([
    'Какие у меня задачи?',
    'Покажи мои задачи',
    'Какие у нас следующие шаги?',
    'Все поручения',
    'Что решили на прошлой неделе?',
    'Какие решения мы приняли?',
    'О чём мы договорились?',
    'О чем договорились вчера?',
    'Договорённости за прошлый месяц',
    'Итоги встреч за этот месяц',
    'Обзор встреч',
    'Сводка за текущую неделю',
  ])('gathers Russian cross-meeting requests: %s', (question) => {
    expect(k(question)).toBe('across')
  })
  it.each([
    'Что сказала Елена о бюджете вчера?',
    'Когда запуск?',
    'Кто упомянул подрядчика?',
    'Обсуждали задачи клиента?',
    'Что значит «псевдообзор встреч»?',
    'Что входит в беззадачие?',
  ])('keeps specific Russian fact searches as find: %s', (question) => {
    expect(k(question)).toBe('find')
  })
})
