import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import * as fs from 'node:fs'
import { launchWithMarkdown, clickMenuById, typeIntoEditor } from './helpers'

// Helper: read the editor's visible text from the DOM (works in reading mode
// where source-code mode is disabled, so we can't fall back on CodeMirror).
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

const waitForEditorToContain = (page: Page, needle: string, timeout = 5000) =>
  page.waitForFunction(
    (text) => {
      const el = document.querySelector('.editor-component') as HTMLElement | null
      return !!el && (el.innerText || el.textContent || '').includes(text)
    },
    needle,
    { timeout }
  )

test.describe('Reading mode', () => {
  let app: ElectronApplication
  let page: Page
  let filePath: string

  test.beforeAll(async() => {
    const launched = await launchWithMarkdown('# Reading mode\n\nOriginal body.\n')
    app = launched.app
    page = launched.page
    filePath = launched.filePath
  })

  test.afterAll(async() => {
    if (app) await app.close()
  })

  // Make sure each test starts from a known state: reading mode off, file
  // contents on disk reset to the launch fixture. The "leaves no class on
  // teardown" test at the end re-asserts this contract.
  test.beforeEach(async() => {
    const isReading = await page.evaluate(() =>
      !!document.querySelector('.editor-wrapper.reading')
    )
    if (isReading) {
      await clickMenuById(app, 'readingModeMenuItem')
      await page.waitForFunction(
        () => !document.querySelector('.editor-wrapper.reading'),
        null,
        { timeout: 5000 }
      )
    }
    fs.writeFileSync(filePath, '# Reading mode\n\nOriginal body.\n', 'utf-8')
    await waitForEditorToContain(page, 'Original body.')
  })

  test('Reading mode sets contenteditable=false on the Muya container', async() => {
    // Muya's getContainer() replaces the editor-component div in place,
    // preserving the class but installing the `contenteditable` attribute on
    // the container itself — so the class selector targets the muya root.
    await clickMenuById(app, 'readingModeMenuItem')
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

    await clickMenuById(app, 'readingModeMenuItem')
    await page.waitForFunction(
      () => !!document.querySelector('.editor-wrapper.reading'),
      null,
      { timeout: 5000 }
    )

    // Menu state propagates from renderer → main via `mt::view-layout-changed`;
    // poll until the disable cascade has caught up rather than racing the IPC.
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
    await clickMenuById(app, 'readingModeMenuItem')
    await page.waitForFunction(
      () => !!document.querySelector('.editor-wrapper.reading'),
      null,
      { timeout: 5000 }
    )

    fs.writeFileSync(filePath, '# Reading mode\n\nReloaded body.\n', 'utf-8')

    // chokidar's stability threshold (~1s) gates the change event, then the
    // renderer applies loadChange. Allow a generous window for that pipeline.
    await waitForEditorToContain(page, 'Reloaded body.', 10000)
    const text = await readEditorText(page)
    expect(text).not.toContain('Original body.')
  })

  test('Reading mode shows an auto-dismissing notification on reload', async() => {
    await clickMenuById(app, 'readingModeMenuItem')
    await page.waitForFunction(
      () => !!document.querySelector('.editor-wrapper.reading'),
      null,
      { timeout: 5000 }
    )

    fs.writeFileSync(filePath, '# Reading mode\n\nNotified body.\n', 'utf-8')

    // Notification banner appears at the bottom of the editor as
    // `.editor-notifications` (per notifications.vue).
    await page.waitForSelector('.editor-notifications', {
      state: 'visible',
      timeout: 10000
    })
    // 3-second store-side timer dismisses the notification. Wait up to 6s
    // (timer + render latency) for the element to detach.
    await page.waitForFunction(
      () => !document.querySelector('.editor-notifications'),
      null,
      { timeout: 6000 }
    )
  })

  test('Keystrokes do not mutate the buffer in reading mode', async() => {
    await clickMenuById(app, 'readingModeMenuItem')
    await page.waitForFunction(
      () => !!document.querySelector('.editor-wrapper.reading'),
      null,
      { timeout: 5000 }
    )

    const before = await readEditorText(page)
    // typeIntoEditor clicks the editor and sends keystrokes. With
    // contenteditable=false the keystrokes should be ignored by the browser
    // and Muya should not record any edit.
    await typeIntoEditor(page, 'INJECTED-PAYLOAD-XYZ ')
    await page.waitForTimeout(300)
    const after = await readEditorText(page)
    expect(after).toBe(before)
    expect(after).not.toContain('INJECTED-PAYLOAD-XYZ')
  })

  test('Format menu actions are no-ops while in reading mode', async() => {
    // Reading mode is the test fixture; we toggle it on AFTER seeding a
    // selection by entering the editor first.
    await page.click('.editor-component')
    await page.waitForTimeout(100)

    await clickMenuById(app, 'readingModeMenuItem')
    await page.waitForFunction(
      () => !!document.querySelector('.editor-wrapper.reading'),
      null,
      { timeout: 5000 }
    )

    // Select the body line in the live DOM so any unguarded format() would
    // see a real range to operate on.
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
    // → Muya.format(); with reading mode on, the guard in Muya.format()
    // returns before contentState is touched.
    await clickMenuById(app, 'strongMenuItem')
    await page.waitForTimeout(200)

    const after = await readEditorText(page)
    expect(after).toBe(before)
  })
})
