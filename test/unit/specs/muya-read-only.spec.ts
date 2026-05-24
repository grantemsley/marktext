import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Muya from 'muya/lib'

interface MutableMuya {
  contentState: {
    updateParagraph: (...args: unknown[]) => void
    duplicate: (...args: unknown[]) => void
    deleteParagraph: (...args: unknown[]) => void
    insertParagraph: (...args: unknown[]) => void
    format: (...args: unknown[]) => void
    insertImage: (...args: unknown[]) => void
    createTable: (...args: unknown[]) => void
    editTable: (...args: unknown[]) => void
    history: { undo: () => void; redo: () => void }
  }
  setReadOnly: (bool: boolean) => void
  isReadOnly: () => boolean
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

// Replace a method on `obj` with a spy that records each call. Returns the
// number of times the spy was invoked since installation.
const installSpy = (obj: Record<string, unknown>, key: string): (() => number) => {
  let count = 0
  obj[key] = () => {
    count++
  }
  return () => count
}

describe('Muya read-only gating', () => {
  let host: HTMLElement
  let muya: MutableMuya

  beforeEach(() => {
    host = document.createElement('div')
    host.id = 'ag-editor-id'
    document.body.appendChild(host)
    muya = new Muya(host, { markdown: '# Hello\n\nA paragraph.\n' }) as unknown as MutableMuya
  })

  afterEach(() => {
    muya.destroy()
    host.remove()
  })

  it('starts editable: contenteditable=true and isReadOnly()=false', () => {
    expect(muya.isReadOnly()).toBe(false)
    expect(muya.container.getAttribute('contenteditable')).toBe('true')
  })

  it('setReadOnly(true) flips the contenteditable attribute and the flag', () => {
    muya.setReadOnly(true)
    expect(muya.isReadOnly()).toBe(true)
    expect(muya.container.getAttribute('contenteditable')).toBe('false')

    muya.setReadOnly(false)
    expect(muya.isReadOnly()).toBe(false)
    expect(muya.container.getAttribute('contenteditable')).toBe('true')
  })

  it('blocks every mutating editor API while read-only', () => {
    const calls = {
      updateParagraph: installSpy(muya.contentState as unknown as Record<string, unknown>, 'updateParagraph'),
      duplicate: installSpy(muya.contentState as unknown as Record<string, unknown>, 'duplicate'),
      deleteParagraph: installSpy(muya.contentState as unknown as Record<string, unknown>, 'deleteParagraph'),
      insertParagraph: installSpy(muya.contentState as unknown as Record<string, unknown>, 'insertParagraph'),
      format: installSpy(muya.contentState as unknown as Record<string, unknown>, 'format'),
      insertImage: installSpy(muya.contentState as unknown as Record<string, unknown>, 'insertImage'),
      createTable: installSpy(muya.contentState as unknown as Record<string, unknown>, 'createTable'),
      editTable: installSpy(muya.contentState as unknown as Record<string, unknown>, 'editTable'),
      undo: installSpy(muya.contentState.history as unknown as Record<string, unknown>, 'undo'),
      redo: installSpy(muya.contentState.history as unknown as Record<string, unknown>, 'redo')
    }

    muya.setReadOnly(true)

    muya.updateParagraph('h2')
    muya.duplicate()
    muya.deleteParagraph()
    muya.insertParagraph('after', 'text', false)
    muya.format('strong')
    muya.insertImage({ src: 'x.png' })
    muya.createTable({ rows: 2, columns: 2 })
    muya.editTable({})
    muya.undo()
    muya.redo()

    for (const [name, calls_] of Object.entries(calls)) {
      expect(calls_(), `${name} should be a no-op in read-only mode`).toBe(0)
    }
  })

  it('resumes mutations once read-only is cleared', () => {
    const formatCalls = installSpy(muya.contentState as unknown as Record<string, unknown>, 'format')

    muya.setReadOnly(true)
    muya.format('strong')
    expect(formatCalls()).toBe(0)

    muya.setReadOnly(false)
    muya.format('strong')
    expect(formatCalls()).toBe(1)
  })
})
