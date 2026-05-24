import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// Catches the "added a key to en.json but forgot the other locales" regression
// — common/i18n.ts returns the raw key string when a translation is missing,
// so any non-English user sees the literal "menu.view.readingMode" in the UI.
// See docs/dev/IPC.md for the i18n contract.

const localesDir = path.resolve(__dirname, '../../../static/locales')

interface I18nDict {
  [key: string]: string | I18nDict
}

const lookup = (dict: I18nDict, keyPath: string): unknown => {
  return keyPath.split('.').reduce<unknown>(
    (cur, segment) =>
      cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[segment] : undefined,
    dict
  )
}

const loadLocale = (locale: string): I18nDict =>
  JSON.parse(fs.readFileSync(path.join(localesDir, `${locale}.json`), 'utf-8'))

const bundledLocales = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'pt', 'zh-CN', 'zh-TW']

// Keys that must exist in every bundled locale. Add new entries here when a
// new translation key is introduced.
const requiredKeys = [
  'menu.view.readingMode',
  'commands.view.readingMode',
  'store.editor.fileReloadedFromDisk'
]

describe('Locale key completeness', () => {
  for (const locale of bundledLocales) {
    it(`${locale}.json defines every required key`, () => {
      const dict = loadLocale(locale)
      for (const key of requiredKeys) {
        const value = lookup(dict, key)
        expect(value, `missing "${key}" in ${locale}.json`).toBeTypeOf('string')
        expect((value as string).length, `empty "${key}" in ${locale}.json`).toBeGreaterThan(0)
      }
    })
  }
})
