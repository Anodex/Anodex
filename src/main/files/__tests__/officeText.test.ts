import { describe, expect, it } from 'vitest'
import { officeText } from '../officeText'
import { zip } from './zipFixture'

describe('officeText', () => {
  it('reads the words of a Word document', () => {
    const docx = zip({
      '[Content_Types].xml': '<Types/>',
      'word/document.xml':
        '<w:document><w:body><w:p><w:r><w:t>Q4 budget &amp; forecast</w:t></w:r></w:p><w:p><w:r><w:t>Friday review</w:t></w:r></w:p></w:body></w:document>'
    })
    const text = officeText(docx, '.docx')
    expect(text).toContain('Q4 budget & forecast')
    expect(text).toContain('Friday review')
  })

  it('reads the shared strings of a spreadsheet', () => {
    const xlsx = zip({
      'xl/sharedStrings.xml': '<sst><si><t>Marketing budget</t></si><si><t>Total</t></si></sst>'
    })
    expect(officeText(xlsx, '.xlsx')).toContain('Marketing budget')
  })

  it('returns nothing, rather than failing, for a broken file', () => {
    expect(officeText(Buffer.from('not a zip at all'), '.docx')).toBe('')
  })

  it('refuses an entry that would inflate past the limit', () => {
    const bomb = zip({ 'word/document.xml': Buffer.alloc(25 * 1024 * 1024, 0x61) })
    expect(officeText(bomb, '.docx')).toBe('')
  })
})
