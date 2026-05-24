import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import * as fs from 'node:fs'
import { launchWithMarkdown, clickMenuById, typeIntoEditor } from './helpers'

// Read the editor's visible text from the DOM. Works in reading mode where
// source-code mode is disabled, so we can't fall back on CodeMirror.
const readEditorText = async(page: Page): Promise<string> => {
  return await page.evaluate(() => {
    const el = document.querySelector('.editor-component') as HTMLElement | null
    return el ? (el.innerText || el.textContent || '') : ''
  })
}

const isMenuItemEnabled = async(app: ElectronApplication, id: string): Promise<boolean> => {
  return await app.evaluate(({ Menu }, menuId) => {
    const menu = Menu.getApplicationMenu()
    if (!menu) throw new Error('Application menu is not built yet')
    const item = menu.getMenuItemById(menuId)
    if (!item) throw new Error('Menu id not found: ' + menuId)
    return item.enabled
  }, id)
}

const enableReadingMode = async(app: ElectronApplication, page: Page): Promise<void> => {
  await clickMenuById(app, 'readingModeMenuItem')
  await page.waitForFunction(
    () => !!document.querySelector('.editor-wrapper.reading'),
    null,
    { timeout: 5000 }
  )
}

const waitForEditorToContain = (page: Page, needle: string, timeout = 10000) =>
  page.waitForFunction(
    (text) => {
      const el = document.querySelector('.editor-component') as HTMLElement | null
      return !!el && (el.innerText || el.textContent || '').includes(text)
    },
    needle,
    { timeout }
  )

// Each test gets a fresh window + temp file so reading-mode state, on-disk
// contents, and notification stacks never leak between tests. Reading mode is
// per-window and notifications are per-tab, so a shared app would otherwise
// carry state across cases.
test.describe('Reading mode', () => {
  let app: ElectronApplication
  let page: Page
  let filePath: string

  test.beforeEach(async() => {
    const launched = await launchWithMarkdown('# Reading mode\n\nOriginal body.\n')
    app = launched.app
    page = launched.page
    filePath = launched.filePath
  })

  test.afterEach(async() => {
    if (app) await app.close()
  })

  test('Reading mode sets contenteditable=false on the Muya container', async() => {
    // Muya's getContainer() replaces the editor-component div in place,
    // copying the class onto the new container and owning the
    // `contenteditable` attribute — so the class selector targets the muya root.
    await enableReadingMode(app, page)
    await page.waitForFunction(
      () => {
        const el = document.querySelector('.editor-component')
        return !!el && el.getAttribute('contenteditable') === 'false'
      },
      null,
      { timeout: 5000 }
    )
    await clickMenuById(app, 'readingModeMenuItem')
    await page.waitForFunction(
      () => {
        const el = document.querySelector('.editor-component')
        return !!el && el.getAttribute('contenteditable') === 'true'
      },
      null,
      { timeout: 5000 }
    )
  })

  test('Reading mode disables sibling editing-oriented mode menu items', async() => {
    expect(await isMenuItemEnabled(app, 'sourceCodeModeMenuItem')).toBe(true)
    expect(await isMenuItemEnabled(app, 'focusModeMenuItem')).toBe(true)
    expect(await isMenuItemEnabled(app, 'typewriterModeMenuItem')).toBe(true)

    await enableReadingMode(app, page)

    // Menu state propagates renderer → main via `mt::view-layout-changed`;
    // poll until the disable cascade catches up rather than racing the IPC.
    await expect.poll(() => isMenuItemEnabled(app, 'sourceCodeModeMenuItem'), {
      timeout: 5000
    }).toBe(false)
    expect(await isMenuItemEnabled(app, 'focusModeMenuItem')).toBe(false)
    expect(await isMenuItemEnabled(app, 'typewriterModeMenuItem')).toBe(false)

    await clickMenuById(app, 'readingModeMenuItem')
    await expect.poll(() => isMenuItemEnabled(app, 'sourceCodeModeMenuItem'), {
      timeout: 5000
    }).toBe(true)
  })

  test('Reading mode reloads the buffer when the file changes on disk', async() => {
    await enableReadingMode(app, page)

    fs.writeFileSync(filePath, '# Reading mode\n\nReloaded body XYZ.\n', 'utf-8')

    // chokidar's stability threshold (~1s) gates the change event, then the
    // renderer applies loadChange. Allow a generous window for that pipeline.
    await waitForEditorToContain(page, 'Reloaded body XYZ.')
    const text = await readEditorText(page)
    expect(text).not.toContain('Original body.')
  })

  test('Reading mode shows an auto-dismissing notification on reload', async() => {
    await enableReadingMode(app, page)

    fs.writeFileSync(filePath, '# Reading mode\n\nNotified body.\n', 'utf-8')

    // Notification banner appears at the bottom of the editor as
    // `.editor-notifications` (see notifications.vue).
    await page.waitForSelector('.editor-notifications', {
      state: 'visible',
      timeout: 10000
    })
    // The 3s store-side timer dismisses it. Wait up to 6s (timer + render
    // latency) for the element to detach.
    await page.waitForFunction(
      () => !document.querySelector('.editor-notifications'),
      null,
      { timeout: 6000 }
    )
  })

  test('Keystrokes do not mutate the buffer in reading mode', async() => {
    await enableReadingMode(app, page)

    const before = await readEditorText(page)
    // typeIntoEditor clicks the editor and sends keystrokes. With
    // contenteditable=false the browser ignores them and Muya records no edit.
    await typeIntoEditor(page, 'INJECTED-PAYLOAD-XYZ ')
    await page.waitForTimeout(300)
    const after = await readEditorText(page)
    expect(after).toBe(before)
    expect(after).not.toContain('INJECTED-PAYLOAD-XYZ')
  })

  test('Format menu actions are no-ops while in reading mode', async() => {
    // Seed a selection on the body line while still editable, then switch to
    // reading mode, so an unguarded format() would have a real range to act on.
    await page.click('.editor-component')
    await page.waitForTimeout(100)

    await enableReadingMode(app, page)

    await page.evaluate(() => {
      const spans = document.querySelectorAll('.editor-component span.ag-paragraph')
      const target = Array.from(spans).find((s) =>
        (s.textContent ?? '').includes('Original body.')
      )
      if (!target) return
      const range = document.createRange()
      range.selectNodeContents(target)
      const sel = window.getSelection()
      if (sel) {
        sel.removeAllRanges()
        sel.addRange(range)
      }
    })
    await page.waitForTimeout(100)

    const before = await readEditorText(page)
    // `strongMenuItem` (Format > Bold) routes through `bus.emit('format', ...)`
    // → Muya.format(); the read-only guard in Muya.format() returns before
    // contentState is touched.
    await clickMenuById(app, 'strongMenuItem')
    await page.waitForTimeout(200)

    const after = await readEditorText(page)
    expect(after).toBe(before)
  })
})
